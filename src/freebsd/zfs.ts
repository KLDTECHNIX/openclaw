/**
 * ZFS integration for FreeClaw agent workspaces on FreeBSD.
 *
 * Provides dataset management, snapshots, COW cloning for sandboxes,
 * tuning (quotas, compression), and backup (send/receive) capabilities.
 *
 * All operations use `execFile` (via promisified child_process) for safe
 * argument handling — no shell interpolation. Errors are wrapped in
 * typed results so callers can handle failures gracefully without
 * try/catch boilerplate.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZfsOk<T> = { ok: true; value: T };
export type ZfsErr = { ok: false; error: string; code?: number | null };
export type ZfsResult<T = void> = ZfsOk<T> | ZfsErr;

export type DatasetUsage = {
  used: string;
  available: string;
  referenced: string;
  mountpoint: string;
};

export type SnapshotInfo = {
  name: string;
  creation: string;
  used: string;
  referenced: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default configuration knobs for ZFS workspace management.
 *
 * - `poolName`        — override pool auto-detection (empty = auto-detect).
 * - `parentDataset`   — dataset prefix under the pool for all FreeClaw data.
 * - `workspacesDir`   — sub-path under parentDataset for agent workspaces.
 * - `sandboxesDir`    — sub-path under parentDataset for sandbox clones.
 * - `baseJailDataset` — dataset holding the base jail template for COW cloning.
 * - `defaultQuota`    — per-workspace quota (empty = no quota).
 * - `compression`     — compression algorithm applied to new datasets.
 * - `timeoutMs`       — max milliseconds for any single ZFS command.
 */
export const ZFS_DEFAULTS = {
  poolName: "",
  parentDataset: "freeclaw",
  workspacesDir: "workspaces",
  sandboxesDir: "sandboxes",
  baseJailDataset: "freeclaw/base-jail",
  defaultQuota: "",
  compression: "lz4" as string,
  timeoutMs: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function zfs(
  args: string[],
  timeoutMs: number = ZFS_DEFAULTS.timeoutMs,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("/sbin/zfs", args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

async function zpool(
  args: string[],
  timeoutMs: number = ZFS_DEFAULTS.timeoutMs,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("/sbin/zpool", args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function fail(error: unknown, fallback: string): ZfsResult<never> {
  if (error && typeof error === "object") {
    const err = error as {
      message?: string;
      stderr?: string;
      code?: number | null;
    };
    const msg = err.stderr?.trim() || err.message || fallback;
    return { ok: false, error: msg, code: err.code ?? undefined };
  }
  return { ok: false, error: fallback };
}

function ok(): ZfsResult<void>;
function ok<T>(value: T): ZfsResult<T>;
function ok<T>(value?: T): ZfsResult<T | void> {
  return { ok: true, value: value as T };
}

/** Cache the pool name once resolved per process lifetime. */
let resolvedPoolCache: string | null = null;

// ---------------------------------------------------------------------------
// 1. Dataset management
// ---------------------------------------------------------------------------

/**
 * Check whether ZFS kernel module is loaded and at least one pool is imported.
 */
export async function isZfsAvailable(): Promise<boolean> {
  try {
    const { stdout } = await zpool(["list", "-H", "-o", "name"], 5_000);
    // At least one pool line means ZFS is functional.
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Determine the ZFS pool to use.
 *
 * Priority:
 *   1. `ZFS_DEFAULTS.poolName` if explicitly configured.
 *   2. A pool named `zroot` (FreeBSD convention).
 *   3. The first pool reported by `zpool list`.
 */
export async function resolveZfsPool(): Promise<ZfsResult<string>> {
  if (resolvedPoolCache) {
    return ok(resolvedPoolCache);
  }
  if (ZFS_DEFAULTS.poolName) {
    resolvedPoolCache = ZFS_DEFAULTS.poolName;
    return ok(resolvedPoolCache);
  }
  try {
    const { stdout } = await zpool(["list", "-H", "-o", "name"]);
    const pools = stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (pools.length === 0) {
      return { ok: false, error: "No ZFS pools found" };
    }
    // Prefer the conventional FreeBSD root pool name.
    resolvedPoolCache = pools.includes("zroot") ? "zroot" : pools[0];
    return ok(resolvedPoolCache);
  } catch (err) {
    return fail(err, "Failed to list ZFS pools");
  }
}

/** Clear the cached pool name (useful for tests). */
export function resetPoolCache(): void {
  resolvedPoolCache = null;
}

/**
 * Build the full dataset path for an agent workspace:
 *   `<pool>/<parentDataset>/<workspacesDir>/<agentId>`
 */
async function resolveWorkspaceDatasetName(agentId: string): Promise<ZfsResult<string>> {
  const poolResult = await resolveZfsPool();
  if (!poolResult.ok) return poolResult;
  const ds = `${poolResult.value}/${ZFS_DEFAULTS.parentDataset}/${ZFS_DEFAULTS.workspacesDir}/${agentId}`;
  return ok(ds);
}

/**
 * Build the full dataset path for a sandbox:
 *   `<pool>/<parentDataset>/<sandboxesDir>/<sessionKey>`
 */
async function resolveSandboxDatasetName(sessionKey: string): Promise<ZfsResult<string>> {
  const poolResult = await resolveZfsPool();
  if (!poolResult.ok) return poolResult;
  const ds = `${poolResult.value}/${ZFS_DEFAULTS.parentDataset}/${ZFS_DEFAULTS.sandboxesDir}/${sessionKey}`;
  return ok(ds);
}

async function datasetExists(dataset: string): Promise<boolean> {
  try {
    await zfs(["list", "-H", "-o", "name", dataset]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `<pool>/freeclaw/workspaces/<agentId>` if it does not exist.
 *
 * Parent datasets are created with `-p` so intermediate paths
 * (e.g. `<pool>/freeclaw`, `<pool>/freeclaw/workspaces`) are
 * created automatically.
 */
export async function ensureWorkspaceDataset(agentId: string): Promise<ZfsResult<string>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult;
  const dataset = nameResult.value;

  if (await datasetExists(dataset)) {
    return ok(dataset);
  }

  try {
    const args = ["create", "-p"];
    if (ZFS_DEFAULTS.compression) {
      args.push("-o", `compression=${ZFS_DEFAULTS.compression}`);
    }
    args.push(dataset);
    await zfs(args);
    return ok(dataset);
  } catch (err) {
    // Race: another process may have created it in between our check and create.
    if (await datasetExists(dataset)) {
      return ok(dataset);
    }
    return fail(err, `Failed to create workspace dataset: ${dataset}`);
  }
}

/**
 * Create a sandbox dataset from the base jail clone.
 *
 * The caller is responsible for calling `createBaseSnapshot()` at least
 * once before invoking this function.
 */
export async function ensureSandboxDataset(sessionKey: string): Promise<ZfsResult<string>> {
  const nameResult = await resolveSandboxDatasetName(sessionKey);
  if (!nameResult.ok) return nameResult;
  const dataset = nameResult.value;

  if (await datasetExists(dataset)) {
    return ok(dataset);
  }

  // Use cloneForSandbox which handles snapshot + clone.
  return cloneForSandbox(sessionKey);
}

/**
 * Destroy a sandbox dataset.  Uses `-r` to remove any child datasets
 * or snapshots created inside the sandbox during its lifetime.
 */
export async function destroySandboxDataset(sessionKey: string): Promise<ZfsResult<void>> {
  const nameResult = await resolveSandboxDatasetName(sessionKey);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const dataset = nameResult.value;

  if (!(await datasetExists(dataset))) {
    // Already gone — idempotent success.
    return ok();
  }

  try {
    await zfs(["destroy", "-r", dataset]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to destroy sandbox dataset: ${dataset}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Snapshots
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of an agent workspace dataset.
 *
 * Result: `<pool>/freeclaw/workspaces/<agentId>@<label>`
 */
export async function createWorkspaceSnapshot(
  agentId: string,
  label: string,
): Promise<ZfsResult<string>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult;
  const snapshot = `${nameResult.value}@${label}`;

  try {
    await zfs(["snapshot", snapshot]);
    return ok(snapshot);
  } catch (err) {
    return fail(err, `Failed to create snapshot: ${snapshot}`);
  }
}

/**
 * List all snapshots for a given agent workspace, newest first.
 */
export async function listWorkspaceSnapshots(agentId: string): Promise<ZfsResult<SnapshotInfo[]>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const dataset = nameResult.value;

  try {
    const { stdout } = await zfs([
      "list",
      "-H",
      "-t",
      "snapshot",
      "-o",
      "name,creation,used,referenced",
      "-s",
      "creation",
      "-r",
      dataset,
    ]);

    const lines = stdout.trim().split("\n").filter(Boolean);
    const snapshots: SnapshotInfo[] = lines.map((line) => {
      // Output is tab-separated.
      const parts = line.split("\t");
      return {
        name: parts[0] ?? "",
        creation: parts[1] ?? "",
        used: parts[2] ?? "",
        referenced: parts[3] ?? "",
      };
    });

    // Reverse to newest-first.
    snapshots.reverse();
    return ok(snapshots);
  } catch (err) {
    // If the dataset simply has no snapshots, zfs list still succeeds with
    // empty output — an error here means something else went wrong.
    return fail(err, `Failed to list snapshots for: ${dataset}`);
  }
}

/**
 * Roll back a workspace to a previously taken snapshot.
 *
 * Uses `-r` to destroy any intermediate snapshots created after the target.
 */
export async function rollbackWorkspace(agentId: string, label: string): Promise<ZfsResult<void>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const snapshot = `${nameResult.value}@${label}`;

  try {
    await zfs(["rollback", "-r", snapshot]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to rollback to snapshot: ${snapshot}`);
  }
}

/**
 * Delete a single snapshot from an agent workspace.
 */
export async function deleteSnapshot(agentId: string, label: string): Promise<ZfsResult<void>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const snapshot = `${nameResult.value}@${label}`;

  try {
    await zfs(["destroy", snapshot]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to delete snapshot: ${snapshot}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Cloning (for sandbox)
// ---------------------------------------------------------------------------

/** Well-known snapshot name on the base jail template used for COW clones. */
const BASE_SNAPSHOT_LABEL = "freeclaw-base";

/**
 * Create (or re-create) the base snapshot on the jail template dataset.
 *
 * This snapshot is the origin for all sandbox COW clones. Should be called
 * once during initial setup or whenever the base jail template is updated.
 */
export async function createBaseSnapshot(): Promise<ZfsResult<string>> {
  const poolResult = await resolveZfsPool();
  if (!poolResult.ok) return poolResult;

  const baseDataset = `${poolResult.value}/${ZFS_DEFAULTS.baseJailDataset}`;
  const snapshot = `${baseDataset}@${BASE_SNAPSHOT_LABEL}`;

  // If the snapshot already exists, destroy and recreate to pick up updates.
  try {
    await zfs(["list", "-H", "-t", "snapshot", snapshot]);
    // Exists — check whether there are dependent clones that prevent destruction.
    // If there are, we skip recreation (callers should promote or destroy clones first).
    try {
      await zfs(["destroy", snapshot]);
    } catch {
      // Dependent clones exist; reuse the existing snapshot.
      return ok(snapshot);
    }
  } catch {
    // Snapshot does not exist yet — that's fine.
  }

  try {
    await zfs(["snapshot", snapshot]);
    return ok(snapshot);
  } catch (err) {
    return fail(err, `Failed to create base snapshot: ${snapshot}`);
  }
}

/**
 * Create a COW clone of the base jail template for a sandbox session.
 *
 * The clone appears as a fully writable dataset whose initial contents
 * are shared (copy-on-write) with the base template — making creation
 * near-instantaneous regardless of template size.
 */
export async function cloneForSandbox(sessionKey: string): Promise<ZfsResult<string>> {
  const poolResult = await resolveZfsPool();
  if (!poolResult.ok) return poolResult;

  const baseSnapshot = `${poolResult.value}/${ZFS_DEFAULTS.baseJailDataset}@${BASE_SNAPSHOT_LABEL}`;

  const nameResult = await resolveSandboxDatasetName(sessionKey);
  if (!nameResult.ok) return nameResult;
  const cloneDataset = nameResult.value;

  if (await datasetExists(cloneDataset)) {
    return ok(cloneDataset);
  }

  // Ensure parent dataset hierarchy exists.
  const parentDataset = cloneDataset.substring(0, cloneDataset.lastIndexOf("/"));
  if (!(await datasetExists(parentDataset))) {
    try {
      await zfs(["create", "-p", parentDataset]);
    } catch {
      // Race condition — parent may have been created concurrently.
      if (!(await datasetExists(parentDataset))) {
        return {
          ok: false,
          error: `Failed to create parent dataset: ${parentDataset}`,
        };
      }
    }
  }

  try {
    await zfs(["clone", baseSnapshot, cloneDataset]);
    return ok(cloneDataset);
  } catch (err) {
    return fail(err, `Failed to clone for sandbox: ${cloneDataset}`);
  }
}

/**
 * Promote a clone so it no longer depends on the origin snapshot.
 *
 * After promotion the clone becomes an independent dataset and the
 * origin snapshot's dependency is transferred to the promoted dataset.
 * This is necessary before destroying the base snapshot when the clone
 * should outlive the template.
 */
export async function promoteClone(sessionKey: string): Promise<ZfsResult<void>> {
  const nameResult = await resolveSandboxDatasetName(sessionKey);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const dataset = nameResult.value;

  try {
    await zfs(["promote", dataset]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to promote clone: ${dataset}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Tuning
// ---------------------------------------------------------------------------

/**
 * Set a disk-space quota on a per-workspace dataset.
 *
 * @param agentId - Agent whose workspace dataset to constrain.
 * @param quota   - ZFS quota string (e.g. "5G", "500M", "none" to remove).
 */
export async function setWorkspaceQuota(agentId: string, quota: string): Promise<ZfsResult<void>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const dataset = nameResult.value;

  try {
    await zfs(["set", `quota=${quota}`, dataset]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to set quota on ${dataset}`);
  }
}

/**
 * Enable (or change) compression on a dataset.
 *
 * @param dataset     - Full dataset path (e.g. `zroot/freeclaw/workspaces/main`).
 * @param algorithm   - Compression algorithm (default: `lz4`).
 */
export async function enableCompression(
  dataset: string,
  algorithm: string = ZFS_DEFAULTS.compression,
): Promise<ZfsResult<void>> {
  try {
    await zfs(["set", `compression=${algorithm}`, dataset]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to enable compression on ${dataset}`);
  }
}

/**
 * Retrieve space usage information for a dataset.
 */
export async function getDatasetUsage(dataset: string): Promise<ZfsResult<DatasetUsage>> {
  try {
    const { stdout } = await zfs(["list", "-H", "-o", "used,avail,refer,mountpoint", dataset]);
    const parts = stdout.trim().split("\t");
    if (parts.length < 4) {
      return { ok: false, error: `Unexpected zfs list output for ${dataset}` };
    }
    return ok({
      used: parts[0],
      available: parts[1],
      referenced: parts[2],
      mountpoint: parts[3],
    });
  } catch (err) {
    return fail(err, `Failed to get usage for ${dataset}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Backup (send / receive)
// ---------------------------------------------------------------------------

/**
 * Stream a snapshot to a file using `zfs send`.
 *
 * The output file can be transported to another machine and restored with
 * `receiveSnapshot()`.  Uses a longer timeout since send can be slow for
 * large datasets.
 *
 * @param agentId    - Agent whose workspace snapshot to send.
 * @param label      - Snapshot label (e.g. "daily-2025-06-01").
 * @param outputPath - Absolute path to the output file.
 */
export async function sendSnapshot(
  agentId: string,
  label: string,
  outputPath: string,
): Promise<ZfsResult<void>> {
  const nameResult = await resolveWorkspaceDatasetName(agentId);
  if (!nameResult.ok) return nameResult as ZfsErr;
  const snapshot = `${nameResult.value}@${label}`;

  try {
    // zfs send piped to a file via shell-free redirect is not possible with
    // execFile alone, so we write to stdout and capture.  For large datasets
    // a streaming approach with spawn would be preferable, but for correctness
    // and consistency we use a two-step approach: send to stdout, write file.
    //
    // Production note: for very large datasets, replace this with a spawn-based
    // pipe to avoid buffering the entire stream in memory.
    const fs = await import("node:fs/promises");
    const { stdout } = await execFileAsync("/sbin/zfs", ["send", snapshot], {
      encoding: "buffer",
      timeout: ZFS_DEFAULTS.timeoutMs * 10, // 5 minutes for large sends.
      maxBuffer: 1024 * 1024 * 512, // 512 MB max buffer.
    });
    await fs.writeFile(outputPath, stdout);
    return ok();
  } catch (err) {
    return fail(err, `Failed to send snapshot: ${snapshot}`);
  }
}

/**
 * Restore a dataset from a `zfs send` stream file.
 *
 * @param inputPath - Absolute path to the send-stream file.
 * @param dataset   - Full target dataset path (will be created by receive).
 */
export async function receiveSnapshot(
  inputPath: string,
  dataset: string,
): Promise<ZfsResult<void>> {
  try {
    const fs = await import("node:fs/promises");
    const data = await fs.readFile(inputPath);
    await execFileAsync("/sbin/zfs", ["receive", "-F", dataset], {
      encoding: "buffer",
      timeout: ZFS_DEFAULTS.timeoutMs * 10,
      maxBuffer: 1024 * 1024 * 512,
      input: data,
    } as Parameters<typeof execFileAsync>[2]);
    return ok();
  } catch (err) {
    return fail(err, `Failed to receive snapshot into: ${dataset}`);
  }
}
