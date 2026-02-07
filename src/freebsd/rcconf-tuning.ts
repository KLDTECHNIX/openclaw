/**
 * FreeBSD rc.conf(5) tuning for FreeClaw.
 *
 * Manages /etc/rc.conf entries for the FreeClaw gateway service, jail
 * support, network interfaces, and recommended system defaults.
 *
 * All writes go through sysrc(8) to guarantee correct quoting and
 * idempotent updates, per FreeBSD porter conventions.
 *
 * Reference: rc.conf(5), sysrc(8), rc(8), rc.subr(8).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RcConfEntry = {
  /** rc.conf variable name */
  key: string;
  /** Recommended value */
  value: string;
  /** Human description */
  description: string;
  /** Category for grouping */
  category: "gateway" | "jail" | "network" | "system";
};

/**
 * Recommended rc.conf entries for a FreeClaw host.
 */
export function buildRecommendedRcConf(opts?: {
  gatewayPort?: number;
  jailName?: string;
  enableJails?: boolean;
}): RcConfEntry[] {
  const port = opts?.gatewayPort ?? 18789;
  const entries: RcConfEntry[] = [
    // ── FreeClaw service ────────────────────────────────────────────
    {
      key: "freeclaw_gateway_enable",
      value: "YES",
      description: "Enable FreeClaw gateway service at boot.",
      category: "gateway",
    },
    {
      key: "freeclaw_gateway_logfile",
      value: "/var/log/freeclaw_gateway.log",
      description: "Gateway log file path.",
      category: "gateway",
    },

    // ── System ──────────────────────────────────────────────────────
    {
      key: "clear_tmp_enable",
      value: "YES",
      description: "Clean /tmp at boot. Prevents stale lock files from surviving reboots.",
      category: "system",
    },
    {
      key: "syslogd_flags",
      value: "-ss",
      description: "Disable remote syslog reception. Security hardening for gateway hosts.",
      category: "system",
    },
    {
      key: "sendmail_enable",
      value: "NO",
      description: "Disable sendmail. Not needed for gateway operation.",
      category: "system",
    },
    {
      key: "sendmail_submit_enable",
      value: "NO",
      description: "Disable sendmail submission.",
      category: "system",
    },
    {
      key: "sendmail_outbound_enable",
      value: "NO",
      description: "Disable sendmail outbound queue.",
      category: "system",
    },
    {
      key: "sendmail_msp_queue_enable",
      value: "NO",
      description: "Disable sendmail MSP queue.",
      category: "system",
    },
    {
      key: "dumpdev",
      value: "NO",
      description: "Disable crash dumps. Saves disk space on production servers.",
      category: "system",
    },

    // ── Network ─────────────────────────────────────────────────────
    {
      key: "tcp_keepalive",
      value: "YES",
      description: "Enable TCP keepalive. Detects dead WebSocket connections.",
      category: "network",
    },
  ];

  // ── Jail support ────────────────────────────────────────────────
  if (opts?.enableJails) {
    entries.push(
      {
        key: "jail_enable",
        value: "YES",
        description: "Enable jail(8) subsystem at boot.",
        category: "jail",
      },
      {
        key: "jail_parallel_start",
        value: "YES",
        description: "Start jails in parallel for faster boot.",
        category: "jail",
      },
      {
        key: "cloned_interfaces",
        value: "lo1",
        description: "Create lo1 cloned loopback for jail networking.",
        category: "jail",
      },
    );
    if (opts.jailName) {
      entries.push({
        key: "jail_list",
        value: opts.jailName,
        description: `Auto-start jail: ${opts.jailName}`,
        category: "jail",
      });
    }
  }

  return entries;
}

/**
 * Read a single rc.conf variable via sysrc(8).
 */
export async function readRcVar(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sysrc", ["-n", key], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Set a single rc.conf variable via sysrc(8).
 */
export async function setRcVar(
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("sysrc", [`${key}=${value}`], { encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type RcConfAuditResult = {
  entry: RcConfEntry;
  current: string | null;
  recommended: string;
  needsChange: boolean;
};

/**
 * Audit current rc.conf against recommended entries.
 */
export async function auditRcConf(
  entries: RcConfEntry[],
): Promise<RcConfAuditResult[]> {
  const results: RcConfAuditResult[] = [];
  for (const entry of entries) {
    const current = await readRcVar(entry.key);
    results.push({
      entry,
      current,
      recommended: entry.value,
      needsChange: current !== entry.value,
    });
  }
  return results;
}

/**
 * Generate rc.conf(5) snippet from entries (for preview/documentation).
 */
export function generateRcConfSnippet(entries: RcConfEntry[]): string {
  const lines: string[] = [
    "# FreeClaw recommended rc.conf settings",
    "# Generated by: freeclaw setup --tune",
    `# Date: ${new Date().toISOString()}`,
    "#",
    "# Apply via: sysrc <key>=<value>",
    "",
  ];

  const categories = ["gateway", "jail", "network", "system"] as const;
  for (const cat of categories) {
    const group = entries.filter((e) => e.category === cat);
    if (group.length === 0) continue;
    lines.push(`# ── ${cat.toUpperCase()} ${"─".repeat(60 - cat.length)}`);
    for (const entry of group) {
      lines.push(`# ${entry.description}`);
      lines.push(`${entry.key}="${entry.value}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
