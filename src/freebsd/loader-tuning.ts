/**
 * FreeBSD loader.conf(5) tuning for FreeClaw.
 *
 * These are boot-time tunables set in /boot/loader.conf that require a
 * reboot to take effect. They load kernel modules and set immutable
 * kernel parameters that cannot be changed at runtime.
 *
 * Reference: loader.conf(5), loader(8), tuning(7).
 */

export type LoaderTunable = {
  /** loader.conf variable name */
  key: string;
  /** Recommended value */
  value: string;
  /** Human description */
  description: string;
  /** Category for grouping */
  category: "modules" | "tcp" | "ipc" | "security" | "performance";
};

/**
 * Recommended loader.conf tunables for a FreeClaw gateway host.
 */
export const LOADER_TUNABLES: LoaderTunable[] = [
  // ── Kernel modules ──────────────────────────────────────────────────
  {
    key: "accf_http_load",
    value: "YES",
    description:
      "Load the HTTP accept filter. Defers accept(2) until a full HTTP " +
      "request arrives, reducing context switches for the gateway.",
    category: "modules",
  },
  {
    key: "accf_data_load",
    value: "YES",
    description:
      "Load the data accept filter. Defers accept(2) until data is " +
      "ready, beneficial for non-HTTP TCP listeners.",
    category: "modules",
  },
  {
    key: "cc_cubic_load",
    value: "YES",
    description:
      "Load the CUBIC congestion control module. Modern algorithm with " +
      "better throughput on high-BDP paths than NewReno.",
    category: "modules",
  },
  {
    key: "aesni_load",
    value: "YES",
    description:
      "Load AES-NI hardware acceleration. Speeds up TLS operations " +
      "(Node.js OpenSSL) on supported CPUs.",
    category: "modules",
  },

  // ── IPC / shared memory ─────────────────────────────────────────────
  {
    key: "kern.ipc.semmni",
    value: "256",
    description: "Maximum semaphore identifiers. Raise if running multiple service instances.",
    category: "ipc",
  },
  {
    key: "kern.ipc.semmns",
    value: "512",
    description: "Maximum semaphores system-wide.",
    category: "ipc",
  },
  {
    key: "kern.ipc.shmmni",
    value: "256",
    description: "Maximum shared memory identifiers.",
    category: "ipc",
  },
  {
    key: "kern.ipc.shmmax",
    value: "134217728",
    description: "Maximum shared memory segment size (128 MB).",
    category: "ipc",
  },

  // ── TCP stack ───────────────────────────────────────────────────────
  {
    key: "net.inet.tcp.soreceive_stream",
    value: "1",
    description:
      "Use optimized stream-mode soreceive. Reduces overhead for " +
      "streaming/WebSocket workloads.",
    category: "tcp",
  },

  // ── Performance ─────────────────────────────────────────────────────
  {
    key: "kern.random.fortuna.minpoolsize",
    value: "128",
    description:
      "Minimum Fortuna entropy pool size. Larger pool means less " +
      "blocking on /dev/random for TLS key generation.",
    category: "performance",
  },
  {
    key: "hw.ibrs_disable",
    value: "1",
    description:
      "Disable Indirect Branch Restricted Speculation (Spectre v2 " +
      "mitigation). Recovers ~5-10%% CPU on non-shared hosts. " +
      "Only recommended for dedicated FreeClaw servers.",
    category: "performance",
  },

  // ── Security ────────────────────────────────────────────────────────
  {
    key: "security.bsd.allow_destructive_dtrace",
    value: "0",
    description: "Prevent DTrace from modifying kernel state. Defense-in-depth.",
    category: "security",
  },
];

/**
 * Read current loader.conf contents.
 */
export async function readLoaderConf(
  path = "/boot/loader.conf",
): Promise<Map<string, string>> {
  const fs = await import("node:fs/promises");
  const entries = new Map<string, string>();
  try {
    const content = await fs.readFile(path, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      entries.set(key, value);
    }
  } catch {
    // File may not exist or not be readable
  }
  return entries;
}

export type LoaderAuditResult = {
  tunable: LoaderTunable;
  current: string | null;
  recommended: string;
  needsChange: boolean;
};

/**
 * Audit loader.conf against recommended tunables.
 */
export async function auditLoaderTunables(
  loaderConfPath = "/boot/loader.conf",
): Promise<LoaderAuditResult[]> {
  const current = await readLoaderConf(loaderConfPath);
  return LOADER_TUNABLES.map((tunable) => {
    const currentVal = current.get(tunable.key) ?? null;
    return {
      tunable,
      current: currentVal,
      recommended: tunable.value,
      needsChange: currentVal !== tunable.value,
    };
  });
}

/**
 * Generate loader.conf(5) content from selected tunables.
 */
export function generateLoaderConf(tunables: LoaderTunable[]): string {
  const lines: string[] = [
    "# FreeClaw gateway boot-time tuning",
    "# Generated by: freeclaw setup --tune",
    `# Date: ${new Date().toISOString()}`,
    "#",
    "# These settings require a reboot to take effect.",
    "# Reference: loader.conf(5), tuning(7)",
    "",
  ];

  const categories = ["modules", "tcp", "ipc", "performance", "security"] as const;
  for (const cat of categories) {
    const group = tunables.filter((t) => t.category === cat);
    if (group.length === 0) continue;
    lines.push(`# ── ${cat.toUpperCase()} ${"─".repeat(60 - cat.length)}`);
    for (const tunable of group) {
      lines.push(`# ${tunable.description}`);
      lines.push(`${tunable.key}="${tunable.value}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
