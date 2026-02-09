/**
 * Port inspection for FreeBSD using sockstat(1) — the native tool for
 * examining open sockets. Falls back to net.createServer probing.
 */
import net from "node:net";
import type { PortListener, PortUsage, PortUsageStatus } from "./ports-types.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { buildPortHints } from "./ports-format.js";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

async function runCommandSafe(argv: string[], timeoutMs = 5_000): Promise<CommandResult> {
  try {
    const res = await runCommandWithTimeout(argv, { timeoutMs });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      code: res.code ?? 1,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: "",
      code: 1,
      error: String(err),
    };
  }
}

/**
 * Parse sockstat(1) output to find listeners on a given port.
 *
 * sockstat -4 -6 -l -p <port> output format:
 *   USER  COMMAND  PID  FD  PROTO  LOCAL ADDRESS  FOREIGN ADDRESS
 *   root  node     1234 3   tcp4   *:18789        *:*
 */
function parseSockstatOutput(output: string, port: number): PortListener[] {
  const listeners: PortListener[] = [];
  const portToken = `:${port}`;
  const lines = output.split(/\r?\n/).filter(Boolean);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Skip header line
    if (line.startsWith("USER") || !line) {
      continue;
    }
    if (!line.includes(portToken)) {
      continue;
    }

    const parts = line.split(/\s+/);
    // USER COMMAND PID FD PROTO LOCAL FOREIGN
    if (parts.length < 6) {
      continue;
    }

    const user = parts[0];
    const command = parts[1];
    const pid = Number.parseInt(parts[2] ?? "", 10);
    const localAddr = parts[5];

    const listener: PortListener = {};
    if (Number.isFinite(pid) && pid > 0) {
      listener.pid = pid;
    }
    if (command) {
      listener.command = command;
    }
    if (user) {
      listener.user = user;
    }
    if (localAddr?.includes(portToken)) {
      listener.address = localAddr;
    }
    listeners.push(listener);
  }
  return listeners;
}

async function resolveCommandLine(pid: number): Promise<string | undefined> {
  // Use procstat -c for full command line on FreeBSD
  const res = await runCommandSafe(["procstat", "-c", String(pid)]);
  if (res.code !== 0) {
    // Fall back to ps
    const psRes = await runCommandSafe(["ps", "-p", String(pid), "-o", "command="]);
    if (psRes.code !== 0) {
      return undefined;
    }
    return psRes.stdout.trim() || undefined;
  }
  // procstat -c output: header + "PID COMM ARGS..."
  const lines = res.stdout.trim().split("\n");
  const dataLine = lines.find((l) => l.trim().startsWith(String(pid)));
  if (!dataLine) {
    return undefined;
  }
  const parts = dataLine.trim().split(/\s+/);
  return parts.slice(1).join(" ") || undefined;
}

async function readSockstatListeners(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  // sockstat: -4 IPv4, -6 IPv6, -l listening only, -p port
  const res = await runCommandSafe(["sockstat", "-4", "-6", "-l", "-p", String(port)]);
  if (res.code === 0) {
    const listeners = parseSockstatOutput(res.stdout, port);
    // Enrich with full command line via procstat
    await Promise.all(
      listeners.map(async (listener) => {
        if (!listener.pid) {
          return;
        }
        const commandLine = await resolveCommandLine(listener.pid);
        if (commandLine) {
          listener.commandLine = commandLine;
        }
      }),
    );
    return { listeners, detail: res.stdout.trim() || undefined, errors };
  }
  const stderr = res.stderr.trim();
  if (res.code === 1 && !res.error && !stderr) {
    return { listeners: [], detail: undefined, errors };
  }
  if (res.error) {
    errors.push(res.error);
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  if (detail) {
    errors.push(detail);
  }
  return { listeners: [], detail: undefined, errors };
}

async function tryListenOnHost(port: number, host: string): Promise<PortUsageStatus | "skip"> {
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen({ port, host, exclusive: true });
    });
    return "free";
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      return "busy";
    }
    if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
      return "skip";
    }
    return "unknown";
  }
}

async function checkPortInUse(port: number): Promise<PortUsageStatus> {
  const hosts = ["127.0.0.1", "0.0.0.0", "::1", "::"];
  let sawUnknown = false;
  for (const host of hosts) {
    const result = await tryListenOnHost(port, host);
    if (result === "busy") {
      return "busy";
    }
    if (result === "unknown") {
      sawUnknown = true;
    }
  }
  return sawUnknown ? "unknown" : "free";
}

export async function inspectPortUsage(port: number): Promise<PortUsage> {
  const errors: string[] = [];
  const result = await readSockstatListeners(port);
  errors.push(...result.errors);
  let listeners = result.listeners;
  let status: PortUsageStatus = listeners.length > 0 ? "busy" : "unknown";
  if (listeners.length === 0) {
    status = await checkPortInUse(port);
  }
  if (status !== "busy") {
    listeners = [];
  }
  const hints = buildPortHints(listeners, port);
  if (status === "busy" && listeners.length === 0) {
    hints.push(
      "Port is in use but process details are unavailable (run sockstat as root for full details).",
    );
  }
  return {
    port,
    status,
    listeners,
    hints,
    detail: result.detail,
    errors: errors.length > 0 ? errors : undefined,
  };
}
