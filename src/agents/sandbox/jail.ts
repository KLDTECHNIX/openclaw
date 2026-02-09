/**
 * FreeBSD jail-based sandbox — drop-in replacement for the Docker sandbox.
 *
 * Uses jail(8) for process isolation, ZFS clones for instant workspace
 * provisioning, rctl(8) for resource limits, devfs(8) for device access
 * control, nullfs for bind-mounts, and tmpfs for scratch space.
 *
 * Exported surface mirrors docker.ts:
 *   ensureJailSandbox()   — create / start a jail  (cf. ensureSandboxContainer)
 *   jailExec()            — run a command inside    (cf. execDocker + docker exec)
 *   destroyJailSandbox()  — tear down jail + ZFS    (cf. removeSandboxContainer)
 *   jailContainerState()  — query running state     (cf. dockerContainerState)
 */

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxJailConfig } from "./types.jail.js";
import type { SandboxWorkspaceAccess } from "./types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { defaultRuntime } from "../../runtime.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { resolveSandboxScopeKey, slugifySessionKey, resolveSandboxAgentId } from "./shared.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period: do not auto-recreate a jail that was used within this window. */
const HOT_JAIL_WINDOW_MS = 5 * 60 * 1000;

/** Default devfs ruleset — ruleset 4 is the conventional restricted set. */
const DEFAULT_DEVFS_RULESET = 4;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

type ExecResult = { stdout: string; stderr: string; code: number };

/**
 * Run an arbitrary command via execFile and return stdout/stderr/code.
 * When `allowFailure` is false (default) a non-zero exit rejects.
 */
async function run(
  bin: string,
  args: string[],
  opts?: { allowFailure?: boolean },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFile(bin, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
    };
    const code = typeof e.code === "number" ? e.code : 1;
    if (opts?.allowFailure) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code };
    }
    const msg = (e.stderr ?? "").trim() || `${bin} ${args.join(" ")} failed (exit ${code})`;
    throw new Error(msg);
  }
}

/** Convenience wrapper for `jls -j <name> ...`. */
async function jls(jailName: string, fields: string[]): Promise<ExecResult> {
  return run("jls", ["-j", jailName, ...fields], { allowFailure: true });
}

// ---------------------------------------------------------------------------
// ZFS helpers
// ---------------------------------------------------------------------------

/** Full ZFS snapshot path (dataset@snap). */
function snapshotPath(cfg: SandboxJailConfig): string {
  return `${cfg.baseDataset}@${cfg.baseSnapshot}`;
}

/** ZFS dataset for a specific jail clone. */
function cloneDataset(cfg: SandboxJailConfig, jailName: string): string {
  return `${cfg.cloneParent}/${jailName}`;
}

/** Mountpoint of a clone dataset (resolved from ZFS). */
async function cloneMountpoint(dataset: string): Promise<string> {
  const { stdout } = await run("zfs", ["get", "-H", "-o", "value", "mountpoint", dataset]);
  return stdout.trim();
}

/** Returns true if the ZFS dataset already exists. */
async function zfsDatasetExists(dataset: string): Promise<boolean> {
  const result = await run("zfs", ["list", "-H", "-o", "name", dataset], { allowFailure: true });
  return result.code === 0 && result.stdout.trim() === dataset;
}

/** Create a ZFS clone from the base snapshot. */
async function zfsClone(cfg: SandboxJailConfig, jailName: string): Promise<string> {
  const dataset = cloneDataset(cfg, jailName);
  if (await zfsDatasetExists(dataset)) {
    return cloneMountpoint(dataset);
  }
  const snap = snapshotPath(cfg);
  // Ensure the parent dataset exists.
  if (!(await zfsDatasetExists(cfg.cloneParent))) {
    await run("zfs", ["create", "-p", cfg.cloneParent]);
  }
  await run("zfs", ["clone", snap, dataset]);
  return cloneMountpoint(dataset);
}

/** Destroy a ZFS clone (and all its snapshots) if it exists. */
async function zfsDestroyClone(cfg: SandboxJailConfig, jailName: string): Promise<void> {
  const dataset = cloneDataset(cfg, jailName);
  if (!(await zfsDatasetExists(dataset))) {
    return;
  }
  await run("zfs", ["destroy", "-r", dataset], { allowFailure: true });
}

// ---------------------------------------------------------------------------
// devfs helpers
// ---------------------------------------------------------------------------

/**
 * Mount devfs inside the jail root with the configured ruleset.
 * Idempotent — skips if /dev is already mounted.
 */
async function mountDevfs(jailRoot: string, ruleset: number): Promise<void> {
  const devPath = path.join(jailRoot, "dev");
  await fs.mkdir(devPath, { recursive: true });
  // Check if already mounted.
  const { stdout } = await run("mount", ["-t", "devfs"], { allowFailure: true });
  if (stdout.includes(devPath)) {
    return;
  }
  await run("mount", ["-t", "devfs", "-o", `ruleset=${ruleset}`, "devfs", devPath]);
}

// ---------------------------------------------------------------------------
// nullfs + tmpfs mount helpers
// ---------------------------------------------------------------------------

async function mountNullfs(src: string, dst: string, readOnly: boolean): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const flags = readOnly ? ["-o", "ro"] : [];
  await run("mount_nullfs", [...flags, src, dst]);
}

async function mountTmpfs(dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  await run("mount", ["-t", "tmpfs", "tmpfs", dst]);
}

// ---------------------------------------------------------------------------
// /etc file provisioning inside the jail
// ---------------------------------------------------------------------------

async function writeResolvConf(jailRoot: string, dns: string[]): Promise<void> {
  const etcDir = path.join(jailRoot, "etc");
  await fs.mkdir(etcDir, { recursive: true });
  const lines = dns.map((addr) => `nameserver ${addr}`);
  await fs.writeFile(path.join(etcDir, "resolv.conf"), lines.join("\n") + "\n", "utf-8");
}

async function writeExtraHosts(jailRoot: string, entries: string[]): Promise<void> {
  const etcDir = path.join(jailRoot, "etc");
  await fs.mkdir(etcDir, { recursive: true });
  const hostsPath = path.join(etcDir, "hosts");
  let existing = "";
  try {
    existing = await fs.readFile(hostsPath, "utf-8");
  } catch {
    existing = "::1\t\tlocalhost\n127.0.0.1\tlocalhost\n";
  }
  const extra = entries.map((e) => {
    // Accept "host:ip" or "ip host" forms.
    const parts = e.includes(":") ? e.split(":").reverse() : e.split(/\s+/);
    return parts.join("\t");
  });
  await fs.writeFile(hostsPath, existing.trimEnd() + "\n" + extra.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// rctl(8) resource-limit helpers
// ---------------------------------------------------------------------------

function buildRctlRules(jailName: string, cfg: SandboxJailConfig): string[] {
  const rules: string[] = [];
  const add = (resource: string, action: string, value: number) => {
    rules.push(`jail:${jailName}:${resource}:${action}=${value}`);
  };

  if (typeof cfg.maxProc === "number" && cfg.maxProc > 0) {
    add("maxproc", "deny", cfg.maxProc);
  }
  if (typeof cfg.memoryuse === "number" && cfg.memoryuse > 0) {
    add("memoryuse", "deny", cfg.memoryuse);
  }
  if (typeof cfg.vmemoryuse === "number" && cfg.vmemoryuse > 0) {
    add("vmemoryuse", "deny", cfg.vmemoryuse);
  }
  if (typeof cfg.pcpu === "number" && cfg.pcpu > 0) {
    add("pcpu", "deny", cfg.pcpu);
  }
  if (typeof cfg.openfiles === "number" && cfg.openfiles > 0) {
    add("openfiles", "deny", cfg.openfiles);
  }
  if (typeof cfg.coredumpsize === "number" && cfg.coredumpsize >= 0) {
    add("coredumpsize", "deny", cfg.coredumpsize);
  }

  for (const raw of cfg.extraRctlRules ?? []) {
    const rule = raw.replace(/\{name\}/g, jailName);
    if (rule.trim()) {
      rules.push(rule.trim());
    }
  }

  return rules;
}

async function applyRctlRules(rules: string[]): Promise<void> {
  for (const rule of rules) {
    await run("rctl", ["-a", rule]);
  }
}

async function removeRctlRules(jailName: string): Promise<void> {
  // Remove all rctl rules attached to this jail.
  await run("rctl", ["-r", `jail:${jailName}`], { allowFailure: true });
}

// ---------------------------------------------------------------------------
// Jail lifecycle
// ---------------------------------------------------------------------------

/**
 * Build the argument array for `jail -c`.
 * Returns the args list (without the leading `jail` binary).
 */
function buildJailCreateArgs(params: {
  jailName: string;
  jailRoot: string;
  cfg: SandboxJailConfig;
}): string[] {
  const { jailName, jailRoot, cfg } = params;

  const args: string[] = [
    "-c",
    `name=${jailName}`,
    `path=${jailRoot}`,
    "persist",
    "host.hostname=" + jailName,
  ];

  // Networking.
  if (cfg.network === "none") {
    args.push("ip4=disable", "ip6=disable");
  } else if (cfg.network === "vnet") {
    args.push("vnet");
  }
  // "inherit" needs no extra flags — the jail shares the host stack.

  // Security: restrict mounts when readOnlyRoot.
  if (cfg.readOnlyRoot) {
    args.push("allow.mount=0", "enforce_statfs=2");
  } else {
    args.push("allow.mount=1", "enforce_statfs=1");
  }

  // Children shall not escalate.
  args.push("children.max=0", "securelevel=3");

  // Additional jail parameters.
  for (const param of cfg.jailParams ?? []) {
    if (param.trim()) {
      args.push(param.trim());
    }
  }

  return args;
}

/**
 * Unmount all filesystems mounted underneath `jailRoot` in reverse order
 * (deepest first) so that cleanup succeeds even with stacked mounts.
 */
async function unmountAllUnder(jailRoot: string): Promise<void> {
  const { stdout } = await run("mount", ["-p"], { allowFailure: true });
  const mounts = stdout
    .split("\n")
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts[1] ?? "";
    })
    .filter((mp) => mp.startsWith(jailRoot + "/") || mp === jailRoot)
    .sort()
    .reverse();

  for (const mp of mounts) {
    await run("umount", ["-f", mp], { allowFailure: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query whether a jail with the given name exists and is running.
 * Equivalent to {@link dockerContainerState}.
 */
export async function jailContainerState(
  jailName: string,
): Promise<{ exists: boolean; running: boolean }> {
  const result = await jls(jailName, ["jid"]);
  if (result.code !== 0 || !result.stdout.trim()) {
    return { exists: false, running: false };
  }
  // If jls returns a JID the jail is alive.
  return { exists: true, running: true };
}

/**
 * Execute a command inside a running jail.
 * Equivalent to `docker exec` — returns stdout/stderr/code.
 */
export async function jailExec(
  jailName: string,
  command: string[],
  opts?: {
    allowFailure?: boolean;
    env?: Record<string, string>;
    uid?: number;
    workdir?: string;
    timeoutMs?: number;
  },
): Promise<ExecResult> {
  const args: string[] = [];

  if (typeof opts?.uid === "number") {
    args.push("-U", String(opts.uid));
  }

  args.push(jailName);

  // If the caller wants a specific workdir or env we wrap in /usr/bin/env + sh.
  const needsWrapper = !!(opts?.env && Object.keys(opts.env).length) || !!opts?.workdir;

  if (needsWrapper) {
    const envPairs = Object.entries(opts?.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const cdPrefix = opts?.workdir ? `cd ${shellEscape(opts.workdir)} &&` : "";
    const inner = command.map(shellEscape).join(" ");
    args.push("/usr/bin/env", ...envPairs, "sh", "-c", `${cdPrefix} ${inner}`);
  } else {
    args.push(...command);
  }

  try {
    const { stdout, stderr } = await execFile("jexec", args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts?.timeoutMs ?? 300_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const code = typeof e.code === "number" ? e.code : 1;
    if (opts?.allowFailure) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code };
    }
    const msg =
      (e.stderr ?? "").trim() || `jexec ${jailName} ${command.join(" ")} failed (exit ${code})`;
    throw new Error(msg);
  }
}

/**
 * Destroy a jail, its mounts, rctl rules, and ZFS clone.
 * Equivalent to `docker rm -f` + ZFS cleanup.
 */
export async function destroyJailSandbox(jailName: string, cfg: SandboxJailConfig): Promise<void> {
  // 1. Remove the jail (sends SIGTERM to all processes inside).
  const state = await jailContainerState(jailName);
  if (state.running) {
    await run("jail", ["-r", jailName], { allowFailure: true });
  }

  // 2. Remove rctl rules.
  await removeRctlRules(jailName);

  // 3. Unmount everything under the jail root before destroying the dataset.
  const dataset = cloneDataset(cfg, jailName);
  if (await zfsDatasetExists(dataset)) {
    const root = await cloneMountpoint(dataset);
    await unmountAllUnder(root);
  }

  // 4. Destroy the ZFS clone.
  await zfsDestroyClone(cfg, jailName);
}

/**
 * Ensure a jail sandbox exists and is running.
 *
 * Follows the same create-or-reuse-with-config-drift logic as
 * {@link ensureSandboxContainer} in docker.ts.
 *
 * Returns the jail name (analogous to Docker container name).
 */
export async function ensureJailSandbox(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: {
    scope: "session" | "agent" | "shared";
    jail: SandboxJailConfig;
    workspaceAccess: SandboxWorkspaceAccess;
  };
}): Promise<string> {
  const { cfg } = params;
  const jailCfg = cfg.jail;

  const scopeKey = resolveSandboxScopeKey(cfg.scope, params.sessionKey);
  const slug = cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const jailName = `${jailCfg.jailPrefix}${slug}`.slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, "_");

  // Compute config hash for drift detection.
  // We reuse the Docker hash helper — it just JSON-serialises a bag of values.
  const expectedHash = computeSandboxConfigHash({
    docker: jailCfg as unknown as Parameters<typeof computeSandboxConfigHash>[0]["docker"],
    workspaceAccess: cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
  });

  const now = Date.now();
  let state = await jailContainerState(jailName);
  let hasJail = state.exists;
  let running = state.running;

  // ── Config-drift detection ──────────────────────────────────────────
  if (hasJail) {
    const registry = await readRegistry();
    const entry = registry.entries.find((e) => e.containerName === jailName);
    const currentHash = entry?.configHash ?? null;
    const hashMismatch = !currentHash || currentHash !== expectedHash;

    if (hashMismatch) {
      const lastUsedAtMs = entry?.lastUsedAtMs;
      const isHot =
        running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_JAIL_WINDOW_MS);

      if (isHot) {
        const hint = formatRecreateHint(cfg.scope, scopeKey);
        defaultRuntime.log(
          `Jail config changed for ${jailName} (recently used). Recreate to apply: ${hint}`,
        );
      } else {
        await destroyJailSandbox(jailName, jailCfg);
        hasJail = false;
        running = false;
      }
    }
  }

  // ── Create ──────────────────────────────────────────────────────────
  if (!hasJail) {
    await createJail({
      jailName,
      cfg: jailCfg,
      workspaceDir: params.workspaceDir,
      workspaceAccess: cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
    });
    running = true;
  }

  // ── Registry bookkeeping ────────────────────────────────────────────
  await updateRegistry({
    containerName: jailName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: `zfs:${snapshotPath(jailCfg)}`,
    configHash: expectedHash,
  });

  return jailName;
}

// ---------------------------------------------------------------------------
// Internal: full jail creation pipeline
// ---------------------------------------------------------------------------

async function createJail(params: {
  jailName: string;
  cfg: SandboxJailConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
}): Promise<void> {
  const { jailName, cfg, workspaceDir, workspaceAccess, agentWorkspaceDir } = params;

  // 1. Provision the root filesystem via ZFS clone.
  const jailRoot = await zfsClone(cfg, jailName);

  try {
    // 2. Mount devfs.
    await mountDevfs(jailRoot, cfg.devfsRuleset ?? DEFAULT_DEVFS_RULESET);

    // 3. Mount tmpfs entries.
    for (const entry of cfg.tmpfs) {
      const dst = path.join(jailRoot, entry);
      await mountTmpfs(dst);
    }

    // 4. Workspace bind-mount via nullfs.
    if (workspaceAccess !== "none") {
      const wsInsideJail = path.join(jailRoot, cfg.workdir);
      const wsReadOnly = workspaceAccess === "ro" && workspaceDir === agentWorkspaceDir;
      await mountNullfs(workspaceDir, wsInsideJail, wsReadOnly);

      // Separate agent workspace mount (if different from primary).
      if (workspaceDir !== agentWorkspaceDir) {
        const agentMount = path.join(jailRoot, SANDBOX_AGENT_WORKSPACE_MOUNT);
        await mountNullfs(agentWorkspaceDir, agentMount, workspaceAccess === "ro");
      }
    }

    // 5. Extra nullfs mounts from config.
    for (const m of cfg.nullfsMounts ?? []) {
      const dst = path.join(jailRoot, m.dst);
      await mountNullfs(m.src, dst, m.readOnly ?? false);
    }

    // 6. DNS / hosts provisioning.
    if (cfg.dns?.length) {
      await writeResolvConf(jailRoot, cfg.dns);
    }
    if (cfg.extraHosts?.length) {
      await writeExtraHosts(jailRoot, cfg.extraHosts);
    }

    // 7. Create the jail.
    const jailArgs = buildJailCreateArgs({ jailName, jailRoot, cfg });
    await run("jail", jailArgs);

    // 8. Apply rctl resource limits.
    const rctlRules = buildRctlRules(jailName, cfg);
    if (rctlRules.length) {
      await applyRctlRules(rctlRules);
    }

    // 9. Run setup command if provided.
    if (cfg.setupCommand?.trim()) {
      await jailExec(jailName, ["sh", "-lc", cfg.setupCommand], {
        uid: cfg.uid,
        env: cfg.env,
        workdir: cfg.workdir,
      });
    }
  } catch (err) {
    // Rollback: tear down everything we set up so far.
    await destroyJailSandbox(jailName, cfg).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Minimal POSIX shell escaping. */
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=@%^+,-]+$/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function formatRecreateHint(scope: "session" | "agent" | "shared", scopeKey: string): string {
  if (scope === "session") {
    return formatCliCommand(`freeclaw sandbox recreate --session ${scopeKey}`);
  }
  if (scope === "agent") {
    const agentId = resolveSandboxAgentId(scopeKey) ?? "main";
    return formatCliCommand(`freeclaw sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("freeclaw sandbox recreate --all");
}
