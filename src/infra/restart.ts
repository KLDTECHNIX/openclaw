import { spawnSync } from "node:child_process";
import { resolveGatewayRcdServiceName } from "../daemon/constants.js";

export type RestartAttempt = {
  ok: boolean;
  method: "rcd" | "supervisor";
  detail?: string;
  tried?: string[];
};

const SPAWN_TIMEOUT_MS = 2000;
const SIGUSR1_AUTH_GRACE_MS = 5000;

let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;

function resetSigusr1AuthorizationIfExpired(now = Date.now()) {
  if (sigusr1AuthorizedCount <= 0) {
    return;
  }
  if (now <= sigusr1AuthorizedUntil) {
    return;
  }
  sigusr1AuthorizedCount = 0;
  sigusr1AuthorizedUntil = 0;
}

export function setGatewaySigusr1RestartPolicy(opts?: { allowExternal?: boolean }) {
  sigusr1ExternalAllowed = opts?.allowExternal === true;
}

export function isGatewaySigusr1RestartExternallyAllowed() {
  return sigusr1ExternalAllowed;
}

export function authorizeGatewaySigusr1Restart(delayMs = 0) {
  const delay = Math.max(0, Math.floor(delayMs));
  const expiresAt = Date.now() + delay + SIGUSR1_AUTH_GRACE_MS;
  sigusr1AuthorizedCount += 1;
  if (expiresAt > sigusr1AuthorizedUntil) {
    sigusr1AuthorizedUntil = expiresAt;
  }
}

export function consumeGatewaySigusr1RestartAuthorization(): boolean {
  resetSigusr1AuthorizationIfExpired();
  if (sigusr1AuthorizedCount <= 0) {
    return false;
  }
  sigusr1AuthorizedCount -= 1;
  if (sigusr1AuthorizedCount <= 0) {
    sigusr1AuthorizedUntil = 0;
  }
  return true;
}

function formatSpawnDetail(result: {
  error?: unknown;
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}): string {
  const clean = (value: string | Buffer | null | undefined) => {
    const text = typeof value === "string" ? value : value ? value.toString() : "";
    return text.replace(/\s+/g, " ").trim();
  };
  if (result.error) {
    if (result.error instanceof Error) {
      return result.error.message;
    }
    if (typeof result.error === "string") {
      return result.error;
    }
    try {
      return JSON.stringify(result.error);
    } catch {
      return "unknown error";
    }
  }
  const stderr = clean(result.stderr);
  if (stderr) {
    return stderr;
  }
  const stdout = clean(result.stdout);
  if (stdout) {
    return stdout;
  }
  if (typeof result.status === "number") {
    return `exit ${result.status}`;
  }
  return "unknown error";
}

export function triggerFreeClawRestart(): RestartAttempt {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return { ok: true, method: "supervisor", detail: "test mode" };
  }
  const tried: string[] = [];
  const serviceName =
    process.env.FREECLAW_RCD_SERVICE?.trim() ||
    resolveGatewayRcdServiceName(process.env.FREECLAW_PROFILE);

  const args = [serviceName, "restart"];
  tried.push(`service ${args.join(" ")}`);
  const res = spawnSync("service", args, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (!res.error && res.status === 0) {
    return { ok: true, method: "rcd", tried };
  }
  return {
    ok: false,
    method: "rcd",
    detail: formatSpawnDetail(res),
    tried,
  };
}

export type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal";
};

export function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
}): ScheduledRestart {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason =
    typeof opts?.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : undefined;
  authorizeGatewaySigusr1Restart(delayMs);
  const pid = process.pid;
  const hasListener = process.listenerCount("SIGUSR1") > 0;
  setTimeout(() => {
    try {
      if (hasListener) {
        process.emit("SIGUSR1");
      } else {
        process.kill(pid, "SIGUSR1");
      }
    } catch {
      /* ignore */
    }
  }, delayMs);
  return {
    ok: true,
    pid,
    signal: "SIGUSR1",
    delayMs,
    reason,
    mode: hasListener ? "emit" : "signal",
  };
}

export const __testing = {
  resetSigusr1State() {
    sigusr1AuthorizedCount = 0;
    sigusr1AuthorizedUntil = 0;
    sigusr1ExternalAllowed = false;
  },
};
