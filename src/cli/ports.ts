import { execFileSync } from "node:child_process";
import { sleep } from "../utils.js";

export type PortProcess = { pid: number; command?: string };

export type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

/**
 * Parse sockstat(1) output into PortProcess entries.
 * sockstat output: USER COMMAND PID FD PROTO LOCAL FOREIGN
 */
export function parseSockstatOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("USER") || !line) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const command = parts[1];
    const pid = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isFinite(pid) && pid > 0) {
      results.push({ pid, command });
    }
  }
  return results;
}

export function listPortListeners(port: number): PortProcess[] {
  try {
    const out = execFileSync("sockstat", ["-4", "-6", "-l", "-p", String(port)], {
      encoding: "utf-8",
    });
    return parseSockstatOutput(out);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error("sockstat not found; required for --force", { cause: err });
    }
    if (status === 1) {
      return [];
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function forceFreePort(port: number): PortProcess[] {
  const listeners = listPortListeners(port);
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
  return listeners;
}

function killPids(listeners: PortProcess[], signal: NodeJS.Signals) {
  for (const proc of listeners) {
    try {
      process.kill(proc.pid, signal);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether sockstat reports listeners. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  const killed = forceFreePort(port);
  if (killed.length === 0) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (listPortListeners(port).length === 0) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  const remaining = listPortListeners(port);
  killPids(remaining, "SIGKILL");

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  const still = listPortListeners(port);
  if (still.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}
