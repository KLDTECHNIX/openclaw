/**
 * FreeBSD sysctl(8) tuning recommendations for FreeClaw.
 *
 * These knobs optimize the kernel for a long-running Node.js messaging
 * gateway that handles many concurrent WebSocket/TCP connections.
 *
 * Reference: FreeBSD Handbook ch. 13 (Tuning & Performance),
 *            sysctl(8), tuning(7), loader.conf(5).
 */

export type SysctlKnob = {
  /** sysctl MIB name */
  key: string;
  /** Recommended value */
  value: string;
  /** Human description */
  description: string;
  /** Category for grouping in the TUI */
  category: "network" | "tcp" | "security" | "ipc" | "vfs";
  /** Whether a reboot is required (loader.conf only) */
  requiresReboot?: boolean;
  /** Whether this is safe to apply at runtime via sysctl(8) */
  runtimeTunable: boolean;
};

/**
 * Recommended sysctl.conf knobs for a FreeClaw gateway host.
 * All values follow FreeBSD best practices for high-connection servers.
 */
export const SYSCTL_KNOBS: SysctlKnob[] = [
  // ── IPC / File descriptors ──────────────────────────────────────────
  {
    key: "kern.maxfiles",
    value: "131072",
    description: "System-wide file descriptor limit (default 32768). Node.js uses one fd per socket.",
    category: "ipc",
    runtimeTunable: true,
  },
  {
    key: "kern.maxfilesperproc",
    value: "104856",
    description: "Per-process file descriptor limit. Must be below kern.maxfiles.",
    category: "ipc",
    runtimeTunable: true,
  },
  {
    key: "kern.ipc.somaxconn",
    value: "4096",
    description: "Listen backlog queue depth (default 128). Prevents SYN drops under burst load.",
    category: "ipc",
    runtimeTunable: true,
  },
  {
    key: "kern.ipc.maxsockbuf",
    value: "4194304",
    description: "Maximum socket buffer size in bytes (4 MB). Ceiling for TCP send/recv buffers.",
    category: "ipc",
    runtimeTunable: true,
  },

  // ── TCP tuning ──────────────────────────────────────────────────────
  {
    key: "net.inet.tcp.sendbuf_max",
    value: "2097152",
    description: "Maximum TCP send buffer (2 MB). Allows large window scaling for WAN clients.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.recvbuf_max",
    value: "2097152",
    description: "Maximum TCP receive buffer (2 MB). Matched to sendbuf_max.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.sendspace",
    value: "65536",
    description: "Default TCP send buffer (64 KB, up from 32 KB). Better throughput per socket.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.recvspace",
    value: "65536",
    description: "Default TCP receive buffer (64 KB). Matched to sendspace.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.fast_finwait2_recycle",
    value: "1",
    description: "Recycle FIN_WAIT_2 connections quickly. Frees sockets faster after disconnect.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.finwait2_timeout",
    value: "5000",
    description: "FIN_WAIT_2 timeout in ms (default 60000). 5 seconds is plenty for local/WAN.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.nolocaltimewait",
    value: "1",
    description: "Skip TIME_WAIT for loopback connections. Essential when gateway and client colocate.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.cc.algorithm",
    value: "cubic",
    description: "TCP congestion control algorithm. cubic is modern and well-tuned for WAN.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.abc_l_var",
    value: "44",
    description: "Appropriate Byte Counting limit. Higher values improve throughput on fast links.",
    category: "tcp",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.msl",
    value: "5000",
    description: "Maximum Segment Lifetime in ms (default 30000). Lower = faster TIME_WAIT expiry.",
    category: "tcp",
    runtimeTunable: true,
  },

  // ── Network hardening ───────────────────────────────────────────────
  {
    key: "net.inet.tcp.blackhole",
    value: "2",
    description: "Drop (don't RST) packets to closed TCP ports. Stealth mode for unused ports.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "net.inet.udp.blackhole",
    value: "1",
    description: "Drop packets to closed UDP ports. Reduces ICMP unreachable noise.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "net.inet.tcp.drop_synfin",
    value: "1",
    description: "Drop SYN+FIN packets. Mitigates OS fingerprinting and certain attacks.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "net.inet.ip.redirect",
    value: "0",
    description: "Ignore ICMP redirects. Prevents route poisoning attacks.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "net.inet.icmp.drop_redirect",
    value: "1",
    description: "Drop incoming ICMP redirect messages.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "security.bsd.unprivileged_proc_debug",
    value: "0",
    description: "Prevent unprivileged process debugging. Hardens multi-user or jail environments.",
    category: "security",
    runtimeTunable: true,
  },
  {
    key: "security.bsd.unprivileged_read_msgbuf",
    value: "0",
    description: "Prevent unprivileged access to kernel message buffer (dmesg).",
    category: "security",
    runtimeTunable: true,
  },
];

/**
 * Read current sysctl value. Returns null if the key doesn't exist.
 */
export async function readSysctl(key: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("sysctl", ["-n", key], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Apply a sysctl value at runtime. Requires appropriate privileges.
 */
export async function applySysctl(
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    await exec("sysctl", [`${key}=${value}`], { encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export type SysctlAuditResult = {
  knob: SysctlKnob;
  current: string | null;
  recommended: string;
  needsChange: boolean;
};

/**
 * Audit all recommended sysctl knobs against current system state.
 */
export async function auditSysctlKnobs(): Promise<SysctlAuditResult[]> {
  const results: SysctlAuditResult[] = [];
  for (const knob of SYSCTL_KNOBS) {
    const current = await readSysctl(knob.key);
    results.push({
      knob,
      current,
      recommended: knob.value,
      needsChange: current !== knob.value,
    });
  }
  return results;
}

/**
 * Generate sysctl.conf(5) content from selected knobs.
 */
export function generateSysctlConf(knobs: SysctlKnob[]): string {
  const lines: string[] = [
    "# FreeClaw gateway system tuning",
    "# Generated by: freeclaw setup --tune",
    `# Date: ${new Date().toISOString()}`,
    "#",
    "# Reference: tuning(7), sysctl(8)",
    "",
  ];

  const categories = ["ipc", "tcp", "network", "security", "vfs"] as const;
  for (const cat of categories) {
    const group = knobs.filter((k) => k.category === cat);
    if (group.length === 0) continue;
    lines.push(`# ── ${cat.toUpperCase()} ${"─".repeat(60 - cat.length)}`);
    for (const knob of group) {
      lines.push(`# ${knob.description}`);
      lines.push(`${knob.key}=${knob.value}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
