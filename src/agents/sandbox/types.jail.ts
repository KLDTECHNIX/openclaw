/**
 * FreeBSD jail sandbox configuration — parallel to {@link SandboxDockerConfig}.
 *
 * Every field maps to a jail(8), rctl(8), devfs(8), or mount(8) concept
 * rather than a Docker/OCI one.
 */
export type SandboxJailConfig = {
  /** ZFS dataset that contains the base root filesystem snapshot (e.g. "zroot/jails/base"). */
  baseDataset: string;

  /**
   * ZFS snapshot name appended to {@link baseDataset} (e.g. "@clean").
   * A ZFS clone is created from `${baseDataset}@${baseSnapshot}` for every jail.
   */
  baseSnapshot: string;

  /** Parent ZFS dataset under which per-jail clones are created (e.g. "zroot/jails/sandboxes"). */
  cloneParent: string;

  /** Prefix applied to jail names (mirrors Docker's `containerPrefix`). */
  jailPrefix: string;

  /** Working directory inside the jail (analogous to Docker `--workdir`). */
  workdir: string;

  /**
   * When true the root filesystem is mounted read-only (`enforce_statfs=2`,
   * `allow.mount=0`) and only explicitly listed tmpfs / nullfs mounts are writable.
   */
  readOnlyRoot: boolean;

  /** Paths inside the jail where tmpfs(4) filesystems are mounted. */
  tmpfs: string[];

  /** VNET jail networking mode: "inherit" (shared stack), "vnet", or "none". */
  network: "inherit" | "vnet" | "none";

  /**
   * Numeric UID that processes inside the jail run as.
   * When undefined the jail inherits the creating process's UID.
   */
  uid?: number;

  /** devfs(8) ruleset number applied to the jail's /dev. */
  devfsRuleset?: number;

  /** Environment variables injected into every `jexec` invocation. */
  env?: Record<string, string>;

  /** Shell command executed inside the jail immediately after creation. */
  setupCommand?: string;

  // ── rctl(8) resource limits ────────────────────────────────────────────

  /** Maximum number of processes (rctl `maxproc`). */
  maxProc?: number;

  /** Maximum resident-set size in bytes (rctl `memoryuse`). */
  memoryuse?: number;

  /** Maximum virtual memory size in bytes (rctl `vmemoryuse`). */
  vmemoryuse?: number;

  /** CPU percentage limit, 100 = one full core (rctl `pcpu`). */
  pcpu?: number;

  /** Maximum open files per process (rctl `openfiles`). */
  openfiles?: number;

  /** Maximum size of a core dump in bytes, 0 disables (rctl `coredumpsize`). */
  coredumpsize?: number;

  /** Additional raw rctl rules appended verbatim (e.g. "jail:{name}:wallclock:deny=3600"). */
  extraRctlRules?: string[];

  // ── extra mounts ───────────────────────────────────────────────────────

  /** Additional nullfs bind-mount specifications: `{ src, dst, readOnly }`. */
  nullfsMounts?: Array<{
    src: string;
    dst: string;
    readOnly?: boolean;
  }>;

  /** Allowed jail parameters passed verbatim to jail(8) (e.g. `["allow.raw_sockets"]`). */
  jailParams?: string[];

  /** DNS resolver addresses written to /etc/resolv.conf inside the jail. */
  dns?: string[];

  /** Extra `/etc/hosts` entries written inside the jail. */
  extraHosts?: string[];
};
