/**
 * FreeBSD rc.d service management for FreeClaw gateway.
 *
 * Manages the gateway as a proper rc.d service under /usr/local/etc/rc.d/,
 * using FreeBSD's rc.subr(8), daemon(8), and service(8) tooling.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  formatGatewayServiceDescription,
  resolveGatewayRcdServiceName,
} from "./constants.js";
import {
  buildRcdScript,
  parseRcdScriptCommand,
  parseRcdScriptEnv,
} from "./rcd-script.js";

const execFileAsync = promisify(execFile);

const RCD_DIR = "/usr/local/etc/rc.d";

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveRcdServiceName(env: Record<string, string | undefined>): string {
  const override = env.FREECLAW_RCD_SERVICE?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayRcdServiceName(env.FREECLAW_PROFILE);
}

function resolveRcdScriptPath(env: Record<string, string | undefined>): string {
  const name = resolveRcdServiceName(env);
  return path.join(RCD_DIR, name);
}

async function execService(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("service", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function execSysrc(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("sysrc", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isRcdServiceAvailable(): Promise<boolean> {
  try {
    await fs.access(RCD_DIR);
    return true;
  } catch {
    return false;
  }
}

export async function readRcdServiceExecStart(
  env: Record<string, string | undefined>,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null> {
  const scriptPath = resolveRcdScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    const parsed = parseRcdScriptCommand(content);
    if (!parsed) {
      return null;
    }

    const serviceName = resolveRcdServiceName(env);
    const environment = parseRcdScriptEnv(content, serviceName) ?? undefined;

    // Extract working directory from the script
    const chdirMatch = content.match(new RegExp(`${serviceName}_chdir="(.+)"`));
    const workingDirectory = chdirMatch?.[1];

    return {
      programArguments: [parsed.command, ...parsed.commandArgs],
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(environment ? { environment } : {}),
      sourcePath: scriptPath,
    };
  } catch {
    return null;
  }
}

export async function installRcdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
}): Promise<{ scriptPath: string }> {
  const available = await isRcdServiceAvailable();
  if (!available) {
    throw new Error(`rc.d directory not found at ${RCD_DIR}; is this FreeBSD?`);
  }

  const serviceName = resolveRcdServiceName(env);
  const scriptPath = resolveRcdScriptPath(env);

  const serviceDescription =
    description ??
    formatGatewayServiceDescription({
      profile: env.FREECLAW_PROFILE,
      version: environment?.FREECLAW_SERVICE_VERSION ?? env.FREECLAW_SERVICE_VERSION,
    });

  const command = programArguments[0];
  if (!command) {
    throw new Error("No command specified for rc.d service");
  }
  const commandArgs = programArguments.slice(1);

  const envRecord: Record<string, string | undefined> = {};
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string" && value.trim()) {
        envRecord[key] = value;
      }
    }
  }

  const script = buildRcdScript({
    name: serviceName,
    description: serviceDescription,
    command,
    commandArgs,
    workingDirectory,
    environment: Object.keys(envRecord).length > 0 ? envRecord : undefined,
    pidFile: `/var/run/${serviceName}.pid`,
    logFile: `/var/log/${serviceName}.log`,
  });

  await fs.writeFile(scriptPath, script, { mode: 0o755 });

  // Enable in rc.conf via sysrc
  const enableResult = await execSysrc([`${serviceName}_enable=YES`]);
  if (enableResult.code !== 0) {
    throw new Error(`sysrc enable failed: ${enableResult.stderr || enableResult.stdout}`.trim());
  }

  // Start the service
  const startResult = await execService([serviceName, "start"]);
  if (startResult.code !== 0) {
    throw new Error(
      `service start failed: ${startResult.stderr || startResult.stdout}`.trim(),
    );
  }

  stdout.write("\n");
  stdout.write(`${formatLine("Installed rc.d service", scriptPath)}\n`);
  return { scriptPath };
}

export async function uninstallRcdService({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const serviceName = resolveRcdServiceName(env);
  const scriptPath = resolveRcdScriptPath(env);

  // Stop the service
  await execService([serviceName, "stop"]);

  // Disable in rc.conf
  await execSysrc([`${serviceName}_enable=NO`]);

  // Remove the rc.d script
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed rc.d service", scriptPath)}\n`);
  } catch {
    stdout.write(`rc.d service not found at ${scriptPath}\n`);
  }
}

export async function stopRcdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const serviceName = resolveRcdServiceName(env ?? {});
  const res = await execService([serviceName, "stop"]);
  if (res.code !== 0) {
    throw new Error(`service stop failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped rc.d service", serviceName)}\n`);
}

export async function restartRcdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const serviceName = resolveRcdServiceName(env ?? {});
  const res = await execService([serviceName, "restart"]);
  if (res.code !== 0) {
    throw new Error(`service restart failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted rc.d service", serviceName)}\n`);
}

export async function isRcdServiceEnabled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const serviceName = resolveRcdServiceName(args.env ?? {});
  const res = await execSysrc(["-n", `${serviceName}_enable`]);
  if (res.code !== 0) {
    return false;
  }
  return res.stdout.trim().toUpperCase() === "YES";
}

export function resolveGatewayLogPaths(env: Record<string, string | undefined>): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const serviceName = resolveRcdServiceName(env);
  const logDir = "/var/log";
  const logFile = `/var/log/${serviceName}.log`;
  return {
    logDir,
    stdoutPath: logFile,
    stderrPath: logFile,
  };
}

export async function readRcdServiceRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const available = await isRcdServiceAvailable();
  if (!available) {
    return {
      status: "unknown",
      detail: "rc.d directory not available",
    };
  }

  const serviceName = resolveRcdServiceName(env);
  const scriptPath = resolveRcdScriptPath(env);

  // Check if the script exists
  try {
    await fs.access(scriptPath);
  } catch {
    return {
      status: "stopped",
      missingUnit: true,
      detail: `rc.d script not found at ${scriptPath}`,
    };
  }

  // Check service status via service(8)
  const res = await execService([serviceName, "status"]);
  const output = (res.stdout || res.stderr).trim().toLowerCase();

  if (res.code === 0 && output.includes("running")) {
    // Extract PID from "is running as pid NNNN"
    const pidMatch = output.match(/pid\s+(\d+)/);
    const pid = pidMatch ? Number.parseInt(pidMatch[1]!, 10) : undefined;
    return {
      status: "running",
      state: "active",
      subState: "running",
      pid: pid && Number.isFinite(pid) ? pid : undefined,
    };
  }

  return {
    status: "stopped",
    state: "inactive",
  };
}
