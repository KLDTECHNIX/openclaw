/**
 * FreeBSD jail(8) automation for FreeClaw.
 *
 * Creates and manages jails purpose-built for running FreeClaw gateway
 * instances in isolation. Follows the FreeBSD Handbook jail administration
 * patterns and uses jail.conf(5) syntax.
 *
 * Reference: jail(8), jail.conf(5), jls(8), jexec(8), pkg(8).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type JailConfig = {
  /** Jail name (e.g. "freeclaw0") */
  name: string;
  /** Jail root filesystem path */
  rootDir: string;
  /** Hostname inside the jail */
  hostname: string;
  /** IPv4 address for the jail */
  ip4Addr?: string;
  /** Network interface to bind (e.g. "lo1", "em0") */
  interface?: string;
  /** Gateway port to expose inside the jail */
  gatewayPort: number;
  /** Whether to allow raw sockets (needed for ping, etc.) */
  allowRawSockets?: boolean;
  /** Additional mount points (host:jail) */
  mounts?: Array<{ src: string; dst: string; readonly?: boolean }>;
};

const DEFAULT_JAIL_ROOT = "/usr/local/jails";
const DEFAULT_JAIL_IP_PREFIX = "127.0.1";

/**
 * Generate jail.conf(5) stanza for a FreeClaw jail.
 */
export function generateJailConf(cfg: JailConfig): string {
  const lines: string[] = [
    `${cfg.name} {`,
    `    host.hostname = "${cfg.hostname}";`,
    `    path = "${cfg.rootDir}";`,
    "",
    "    # Lifecycle",
    "    exec.start = \"/bin/sh /etc/rc\";",
    "    exec.stop = \"/bin/sh /etc/rc.shutdown jail\";",
    "    exec.clean;",
    "    mount.devfs;",
    "",
  ];

  // Networking
  if (cfg.ip4Addr) {
    const iface = cfg.interface ?? "lo1";
    lines.push("    # Network");
    lines.push(`    ip4.addr = ${iface}|${cfg.ip4Addr};`);
    lines.push("");
  }

  // Security
  lines.push("    # Security policy");
  lines.push("    enforce_statfs = 2;");
  lines.push("    children.max = 0;");
  lines.push(`    allow.raw_sockets = ${cfg.allowRawSockets ? "1" : "0"};`);
  lines.push("    allow.chflags = 0;");
  lines.push("    allow.sysvipc = 0;");
  lines.push("");

  // FreeClaw-specific
  lines.push("    # FreeClaw gateway");
  lines.push("    exec.prestart = \"ifconfig lo1 alias " + (cfg.ip4Addr ?? "127.0.1.1") + " netmask 255.255.255.255 || true\";");
  lines.push("    exec.poststop = \"ifconfig lo1 -alias " + (cfg.ip4Addr ?? "127.0.1.1") + " || true\";");

  // Mounts
  if (cfg.mounts && cfg.mounts.length > 0) {
    lines.push("");
    lines.push("    # Mount points");
    for (const mount of cfg.mounts) {
      const ro = mount.readonly ? " ro" : "";
      lines.push(
        `    mount.fstab = "${cfg.rootDir}/etc/fstab.freeclaw";`,
      );
      // We'll generate fstab separately
      break;
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate /etc/fstab for inside the jail (mount_nullfs entries).
 */
export function generateJailFstab(cfg: JailConfig): string {
  const lines = ["# FreeClaw jail mount points"];
  if (cfg.mounts) {
    for (const mount of cfg.mounts) {
      const opts = mount.readonly ? "ro" : "rw";
      lines.push(`${mount.src}\t${cfg.rootDir}${mount.dst}\tnullfs\t${opts}\t0\t0`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Generate rc.conf entries needed for jail support.
 */
export function generateJailRcConf(jailNames: string[]): string {
  const lines = [
    "# FreeClaw jail support",
    'jail_enable="YES"',
    `jail_list="${jailNames.join(" ")}"`,
    "",
    "# Cloned loopback for jail networking",
    'cloned_interfaces="lo1"',
  ];
  return lines.join("\n") + "\n";
}

/**
 * Bootstrap a minimal FreeBSD jail filesystem for FreeClaw.
 *
 * Uses the host's /usr/freebsd-dist or fetches a base.txz if needed.
 * Then installs Node.js and FreeClaw inside the jail via pkg(8).
 */
export async function bootstrapJail(cfg: JailConfig, opts?: {
  onProgress?: (msg: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
  const log = opts?.onProgress ?? (() => {});

  try {
    // Create jail root
    log(`Creating jail root: ${cfg.rootDir}`);
    await fs.mkdir(cfg.rootDir, { recursive: true });

    // Extract base system
    const baseTxz = "/usr/freebsd-dist/base.txz";
    try {
      await fs.access(baseTxz);
      log("Extracting base.txz into jail...");
      await execFileAsync("tar", ["-xf", baseTxz, "-C", cfg.rootDir], {
        encoding: "utf8",
        timeout: 300_000,
      });
    } catch {
      // No base.txz available; try bsdinstall or fetch
      log("base.txz not found at /usr/freebsd-dist/; attempting fetch...");
      const version = await getFreeBSDVersion();
      const arch = await getArch();
      const url = `https://download.freebsd.org/releases/${arch}/${version}/base.txz`;
      log(`Fetching ${url}...`);
      try {
        await execFileAsync("fetch", ["-o", path.join(cfg.rootDir, ".base.txz"), url], {
          encoding: "utf8",
          timeout: 600_000,
        });
        await execFileAsync(
          "tar",
          ["-xf", path.join(cfg.rootDir, ".base.txz"), "-C", cfg.rootDir],
          { encoding: "utf8", timeout: 300_000 },
        );
        await fs.unlink(path.join(cfg.rootDir, ".base.txz")).catch(() => {});
      } catch (fetchErr) {
        return {
          ok: false,
          error: `Failed to fetch base.txz: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        };
      }
    }

    // Copy resolv.conf from host
    log("Configuring DNS...");
    await fs.copyFile("/etc/resolv.conf", path.join(cfg.rootDir, "etc/resolv.conf"));

    // Set timezone from host
    try {
      await fs.copyFile("/etc/localtime", path.join(cfg.rootDir, "etc/localtime"));
    } catch {
      // Not critical
    }

    // Bootstrap pkg inside jail
    log("Bootstrapping pkg(8) in jail...");
    await execFileAsync("pkg", ["-j", cfg.name, "bootstrap", "-fy"], {
      encoding: "utf8",
      timeout: 120_000,
    }).catch(async () => {
      // Jail might not be running yet; start it first
      await execFileAsync("jail", ["-c", "-f", "/etc/jail.conf", cfg.name], {
        encoding: "utf8",
        timeout: 30_000,
      }).catch(() => {});
      await execFileAsync("pkg", ["-j", cfg.name, "bootstrap", "-fy"], {
        encoding: "utf8",
        timeout: 120_000,
      });
    });

    // Install Node.js in jail
    log("Installing node22 and npm in jail...");
    await execFileAsync("pkg", ["-j", cfg.name, "install", "-y", "node22", "npm-node22"], {
      encoding: "utf8",
      timeout: 300_000,
    });

    // Install FreeClaw in jail
    log("Installing freeclaw in jail...");
    await execFileAsync("jexec", [cfg.name, "npm", "install", "-g", "freeclaw"], {
      encoding: "utf8",
      timeout: 300_000,
    });

    // Write jail rc.conf for FreeClaw service
    log("Configuring rc.conf inside jail...");
    const jailRcConf = [
      "# FreeClaw jail rc.conf",
      'sendmail_enable="NO"',
      'sendmail_submit_enable="NO"',
      'sendmail_outbound_enable="NO"',
      'sendmail_msp_queue_enable="NO"',
      'syslogd_flags="-ss"',
      'cron_flags="-J 60"',
      'freeclaw_gateway_enable="YES"',
      `freeclaw_gateway_logfile="/var/log/freeclaw_gateway.log"`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(cfg.rootDir, "etc/rc.conf"), jailRcConf);

    log("Jail bootstrap complete.");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List running jails.
 */
export async function listJails(): Promise<
  Array<{ jid: number; name: string; path: string; hostname: string }>
> {
  try {
    const { stdout } = await execFileAsync("jls", ["-q", "jid", "name", "path", "host.hostname"], {
      encoding: "utf8",
    });
    const jails: Array<{ jid: number; name: string; path: string; hostname: string }> = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      jails.push({
        jid: Number.parseInt(parts[0]!, 10),
        name: parts[1]!,
        path: parts[2]!,
        hostname: parts[3]!,
      });
    }
    return jails;
  } catch {
    return [];
  }
}

/**
 * Check if a jail exists in jail.conf.
 */
export async function jailExistsInConf(
  name: string,
  confPath = "/etc/jail.conf",
): Promise<boolean> {
  try {
    const content = await fs.readFile(confPath, "utf8");
    const re = new RegExp(`^${escapeRegex(name)}\\s*\\{`, "m");
    return re.test(content);
  } catch {
    return false;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getFreeBSDVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("freebsd-version", ["-u"], { encoding: "utf8" });
    // e.g. "14.1-RELEASE" → "14.1-RELEASE"
    return stdout.trim();
  } catch {
    return "14.0-RELEASE";
  }
}

async function getArch(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("uname", ["-m"], { encoding: "utf8" });
    return stdout.trim(); // e.g. "amd64"
  } catch {
    return "amd64";
  }
}

/**
 * Determine next available jail IP on the loopback alias range.
 */
export async function nextJailIp(prefix = DEFAULT_JAIL_IP_PREFIX): Promise<string> {
  const jails = await listJails();
  const usedLast = new Set<number>();
  for (const jail of jails) {
    // parse existing IPs from ifconfig
    try {
      const { stdout } = await execFileAsync("jexec", [String(jail.jid), "ifconfig", "lo1"], {
        encoding: "utf8",
      });
      const match = stdout.match(new RegExp(`${escapeRegex(prefix)}\\.(\\d+)`));
      if (match) {
        usedLast.add(Number.parseInt(match[1]!, 10));
      }
    } catch {
      // Jail might not have lo1
    }
  }
  for (let i = 1; i < 255; i++) {
    if (!usedLast.has(i)) {
      return `${prefix}.${i}`;
    }
  }
  return `${prefix}.1`;
}

/**
 * Resolve default jail configuration for a FreeClaw instance.
 */
export function resolveDefaultJailConfig(opts?: {
  name?: string;
  ip4Addr?: string;
  gatewayPort?: number;
  rootDir?: string;
}): JailConfig {
  const name = opts?.name ?? "freeclaw0";
  return {
    name,
    rootDir: opts?.rootDir ?? path.join(DEFAULT_JAIL_ROOT, name),
    hostname: `${name}.local`,
    ip4Addr: opts?.ip4Addr ?? "127.0.1.1",
    interface: "lo1",
    gatewayPort: opts?.gatewayPort ?? 18789,
    allowRawSockets: false,
  };
}
