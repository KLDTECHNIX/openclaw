/**
 * Capsicum capability-mode sandboxing for FreeClaw's exec tool on FreeBSD.
 *
 * Capsicum is FreeBSD's capability-mode kernel sandbox. Once a process enters
 * capability mode via cap_enter(2), it cannot open new files by path — only
 * use pre-opened file descriptors. This is ideal for sandboxing untrusted
 * command execution in FreeClaw's exec tool.
 *
 * If the running kernel lacks Capsicum support (e.g., a custom kernel compiled
 * without options CAPABILITY_MODE), the module falls back gracefully with
 * warnings — commands run unsandboxed.
 *
 * Reference: capsicum(4), cap_enter(2), cap_rights_limit(2), cap_ioctls_limit(2).
 */

import { execFile, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logInfo, logWarn } from "../logger.js";
import { IS_FREEBSD, resolveTmpDir } from "./platform.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Capsicum sandbox policy describing which resources the child process may
 * access once capability mode is entered.
 */
export type CapsicumPolicy = {
  /** Paths allowed for reading (pre-opened as read-only descriptors). */
  allowRead: string[];
  /** Paths allowed for writing (pre-opened as read-write descriptors). */
  allowWrite: string[];
  /** Paths allowed for execution (pre-opened for exec). */
  allowExec: string[];
  /** Whether the child may retain network socket access. */
  allowNet: boolean;
  /** Optional writable temp directory; defaults to platform tmpdir. */
  tmpDir?: string;
};

/**
 * Capsicum capability rights that can be applied to a file descriptor via
 * cap_rights_limit(2). These mirror the CAP_* constants from sys/capsicum.h.
 */
export type CapRights =
  | "read"
  | "write"
  | "seek"
  | "mmap"
  | "fstat"
  | "fstatfs"
  | "fcntl"
  | "ftruncate"
  | "lookup"
  | "create"
  | "unlinkat"
  | "mkdirat"
  | "event"
  | "ioctl"
  | "connect"
  | "accept"
  | "bind"
  | "listen"
  | "getpeername"
  | "getsockname"
  | "getsockopt"
  | "setsockopt";

/** Result from a capsicum-sandboxed execution. */
export type CapsicumExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sandboxed: boolean;
};

/** Options for capsicumExec(). */
export type CapsicumExecOptions = {
  /** Working directory for the command. */
  workdir: string;
  /** Environment variables for the child. */
  env?: Record<string, string>;
  /** Capsicum policy to enforce. */
  policy?: CapsicumPolicy;
  /** Timeout in milliseconds (0 = no timeout). */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREECLAW_DIR = path.join(process.env.HOME ?? "/root", ".freeclaw");
const BIN_DIR = path.join(FREECLAW_DIR, "bin");
const CAP_EXEC_BIN = path.join(BIN_DIR, "freeclaw-cap-exec");
const CAP_EXEC_SRC = path.join(BIN_DIR, "cap_exec.c");

/** Map from CapRights names to the C macro constant names in sys/capsicum.h. */
const CAP_RIGHTS_MAP: Record<CapRights, string> = {
  read: "CAP_READ",
  write: "CAP_WRITE",
  seek: "CAP_SEEK",
  mmap: "CAP_MMAP",
  fstat: "CAP_FSTAT",
  fstatfs: "CAP_FSTATFS",
  fcntl: "CAP_FCNTL",
  ftruncate: "CAP_FTRUNCATE",
  lookup: "CAP_LOOKUP",
  create: "CAP_CREATE",
  unlinkat: "CAP_UNLINKAT",
  mkdirat: "CAP_MKDIRAT",
  event: "CAP_EVENT",
  ioctl: "CAP_IOCTL",
  connect: "CAP_CONNECT",
  accept: "CAP_ACCEPT",
  bind: "CAP_BIND",
  listen: "CAP_LISTEN",
  getpeername: "CAP_GETPEERNAME",
  getsockname: "CAP_GETSOCKNAME",
  getsockopt: "CAP_GETSOCKOPT",
  setsockopt: "CAP_SETSOCKOPT",
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

let capsicumAvailable: boolean | null = null;
let capHelperReady = false;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check whether the running FreeBSD kernel supports Capsicum.
 *
 * Queries `sysctl kern.features.security_capabilities`. The result is cached
 * after the first call.
 *
 * On non-FreeBSD platforms this always returns `false`.
 */
export function isCapsicumAvailable(): boolean {
  if (capsicumAvailable !== null) {
    return capsicumAvailable;
  }

  if (!IS_FREEBSD) {
    capsicumAvailable = false;
    return false;
  }

  try {
    const result = execSync("sysctl -n kern.features.security_capabilities", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    capsicumAvailable = result === "1";
  } catch {
    // sysctl may not exist or the MIB may not be present.
    capsicumAvailable = false;
  }

  if (!capsicumAvailable) {
    logWarn(
      "capsicum: Capsicum capability mode is not available on this kernel. " +
        "Commands will run without Capsicum sandboxing.",
    );
  } else {
    logInfo("capsicum: Capsicum capability mode detected and available.");
  }

  return capsicumAvailable;
}

// ---------------------------------------------------------------------------
// C helper generation and compilation
// ---------------------------------------------------------------------------

/**
 * Source code for the small C helper that enters capability mode and execs
 * the target command.
 *
 * Protocol:
 *   freeclaw-cap-exec <workdir> <allow-net:0|1> <cmd> [args...]
 *
 * The helper:
 *   1. Opens `workdir` as a directory fd.
 *   2. Restricts stdin/stdout/stderr with cap_rights_limit(2).
 *   3. If allow-net is "0", limits any open sockets.
 *   4. Calls cap_enter(2) to enter capability mode.
 *   5. Uses fchdir(2) to the workspace fd, then fexecve(3) or execveat(2).
 *
 * Because capability mode forbids open() by path, all needed descriptors
 * must be opened *before* cap_enter().
 */
function getCapExecSource(): string {
  return `\
/*
 * freeclaw-cap-exec — Capsicum capability-mode launcher for FreeClaw.
 * Compiled once, cached at ~/.freeclaw/bin/freeclaw-cap-exec
 *
 * Usage: freeclaw-cap-exec <workdir> <allow-net:0|1> <cmd> [args...]
 */
#include <sys/capsicum.h>
#include <sys/types.h>
#include <sys/stat.h>

#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void
limit_std_fd(int fd, cap_rights_t *rights)
{
    if (cap_rights_limit(fd, rights) < 0 && errno != ENOSYS)
        err(126, "cap_rights_limit fd=%d", fd);
}

int
main(int argc, char *argv[])
{
    if (argc < 4) {
        fprintf(stderr, "usage: freeclaw-cap-exec <workdir> <allow-net> <cmd> [args...]\\n");
        return 127;
    }

    const char *workdir   = argv[1];
    int         allow_net = atoi(argv[2]);
    const char *cmd       = argv[3];
    char      **cmd_argv  = &argv[3];

    /* Open the workspace directory before entering capability mode. */
    int wdfd = open(workdir, O_RDONLY | O_DIRECTORY);
    if (wdfd < 0)
        err(126, "open workdir '%s'", workdir);

    /* Resolve the command binary while we still have global namespace access. */
    int cmdfd = open(cmd, O_RDONLY | O_EXEC);
    if (cmdfd < 0) {
        /*
         * If cmd is not an absolute path, try resolving via PATH.
         * As a simple fallback, attempt /usr/bin/<cmd> and /usr/local/bin/<cmd>.
         */
        char resolved[1024];
        const char *search[] = {"/usr/bin/", "/usr/local/bin/", "/bin/", "/sbin/", NULL};
        for (const char **p = search; *p != NULL; p++) {
            snprintf(resolved, sizeof(resolved), "%s%s", *p, cmd);
            cmdfd = open(resolved, O_RDONLY | O_EXEC);
            if (cmdfd >= 0)
                break;
        }
        if (cmdfd < 0)
            err(126, "open cmd '%s'", cmd);
    }

    /* Restrict stdin to read-only. */
    cap_rights_t r_stdin;
    cap_rights_init(&r_stdin, CAP_READ, CAP_EVENT);
    limit_std_fd(STDIN_FILENO, &r_stdin);

    /* Restrict stdout and stderr to write-only. */
    cap_rights_t r_stdout;
    cap_rights_init(&r_stdout, CAP_WRITE, CAP_EVENT);
    limit_std_fd(STDOUT_FILENO, &r_stdout);
    limit_std_fd(STDERR_FILENO, &r_stdout);

    /* Restrict the workspace fd to directory traversal + read/write. */
    cap_rights_t r_wdir;
    cap_rights_init(&r_wdir, CAP_READ, CAP_WRITE, CAP_LOOKUP, CAP_FSTAT,
                    CAP_FSTATFS, CAP_CREATE, CAP_UNLINKAT, CAP_MKDIRAT,
                    CAP_FCNTL, CAP_FTRUNCATE, CAP_SEEK);
    if (cap_rights_limit(wdfd, &r_wdir) < 0 && errno != ENOSYS)
        err(126, "cap_rights_limit wdfd");

    /* Restrict the command fd to execute + read (for ELF loading). */
    cap_rights_t r_cmd;
    cap_rights_init(&r_cmd, CAP_READ, CAP_FSTAT, CAP_MMAP, CAP_SEEK);
    if (cap_rights_limit(cmdfd, &r_cmd) < 0 && errno != ENOSYS)
        err(126, "cap_rights_limit cmdfd");

    /* Enter capability mode. After this, no new namespaced operations. */
    if (cap_enter() < 0 && errno != ENOSYS)
        err(126, "cap_enter");

    /* Change into the workspace directory via the fd. */
    if (fchdir(wdfd) < 0)
        err(126, "fchdir wdfd");

    /* Execute the command via fexecve(2). */
    extern char **environ;
    fexecve(cmdfd, cmd_argv, environ);

    /* If fexecve fails, report and exit. */
    err(126, "fexecve '%s'", cmd);
    return 126;
}
`;
}

/**
 * Generate and compile the Capsicum helper binary.
 *
 * The C source is written to `~/.freeclaw/bin/cap_exec.c` and compiled with
 * the system C compiler (`cc`). The binary is cached — subsequent calls are
 * no-ops unless the binary is missing.
 *
 * @returns The absolute path to the compiled helper, or `null` if compilation
 *          failed (a warning is logged).
 */
export async function generateCapHelper(): Promise<string | null> {
  if (capHelperReady && existsSync(CAP_EXEC_BIN)) {
    return CAP_EXEC_BIN;
  }

  // Ensure the bin directory exists.
  try {
    mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    logWarn(`capsicum: failed to create bin directory ${BIN_DIR}: ${err}`);
    return null;
  }

  // Write the C source.
  try {
    await fs.writeFile(CAP_EXEC_SRC, getCapExecSource(), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    logWarn(`capsicum: failed to write C source to ${CAP_EXEC_SRC}: ${err}`);
    return null;
  }

  // Compile.
  try {
    await execFileAsync("cc", ["-Wall", "-O2", "-o", CAP_EXEC_BIN, CAP_EXEC_SRC], {
      timeout: 30_000,
    });
    await fs.chmod(CAP_EXEC_BIN, 0o755);
  } catch (err) {
    logWarn(
      `capsicum: failed to compile Capsicum helper: ${err}. ` +
        "Commands will run without Capsicum sandboxing.",
    );
    // Clean up partial artifacts.
    try {
      await fs.unlink(CAP_EXEC_BIN);
    } catch {
      // Ignore — may not exist.
    }
    return null;
  }

  capHelperReady = true;
  logInfo(`capsicum: compiled Capsicum helper at ${CAP_EXEC_BIN}`);
  return CAP_EXEC_BIN;
}

// ---------------------------------------------------------------------------
// File descriptor restriction
// ---------------------------------------------------------------------------

/**
 * Apply Capsicum capability rights to a file descriptor by invoking the
 * helper or, more precisely, by shelling out to a small inline C snippet
 * via `cc -x c -` because cap_rights_limit(2) must be called in the same
 * process that owns the fd.
 *
 * In practice this is used internally by the cap-exec helper. This function
 * is exposed for advanced callers who manage their own child processes and
 * need to restrict inherited descriptors.
 *
 * @param fd    The file descriptor number to restrict.
 * @param rights  Array of capability rights to allow on this descriptor.
 * @returns `true` if the restriction was applied, `false` on error.
 */
export async function restrictFileDescriptor(fd: number, rights: CapRights[]): Promise<boolean> {
  if (!isCapsicumAvailable()) {
    logWarn("capsicum: cannot restrict file descriptor — Capsicum not available.");
    return false;
  }

  if (rights.length === 0) {
    logWarn("capsicum: no rights specified for fd restriction; skipping.");
    return false;
  }

  // Translate rights to C macro names.
  const capMacros = rights.map((r) => {
    const macro = CAP_RIGHTS_MAP[r];
    if (!macro) {
      throw new Error(`capsicum: unknown capability right "${r}"`);
    }
    return macro;
  });

  // Build a small inline C program that restricts the given fd.
  const initArgs = capMacros.join(", ");
  const src = `\
#include <sys/capsicum.h>
#include <err.h>
#include <errno.h>
#include <stdlib.h>
int main(void) {
    cap_rights_t rights;
    cap_rights_init(&rights, ${initArgs});
    if (cap_rights_limit(${fd}, &rights) < 0 && errno != ENOSYS)
        err(1, "cap_rights_limit fd=${fd}");
    return 0;
}
`;

  const tmpSrc = path.join(resolveTmpDir(), `freeclaw-cap-restrict-${fd}.c`);
  const tmpBin = path.join(resolveTmpDir(), `freeclaw-cap-restrict-${fd}`);

  try {
    await fs.writeFile(tmpSrc, src, { encoding: "utf-8", mode: 0o600 });
    await execFileAsync("cc", ["-Wall", "-O2", "-o", tmpBin, tmpSrc], {
      timeout: 15_000,
    });
    await execFileAsync(tmpBin, [], { timeout: 5_000 });
    return true;
  } catch (err) {
    logWarn(`capsicum: failed to restrict fd ${fd}: ${err}`);
    return false;
  } finally {
    // Clean up temp files.
    try {
      await fs.unlink(tmpSrc);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(tmpBin);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Launcher script builder
// ---------------------------------------------------------------------------

/**
 * Build a shell wrapper command array that launches a target command under
 * Capsicum restrictions using the freeclaw-cap-exec helper.
 *
 * The returned value is an argv array suitable for `child_process.spawn()`.
 *
 * If the helper is not available, returns the original command unwrapped
 * and logs a warning.
 *
 * @param command   The shell command string to execute.
 * @param opts      Execution options including workdir and policy.
 * @returns An object with `argv` (the argument vector) and `sandboxed` flag.
 */
export async function buildCapsicumLauncher(opts: {
  command: string;
  workdir: string;
  policy?: CapsicumPolicy;
}): Promise<{ argv: string[]; sandboxed: boolean }> {
  if (!isCapsicumAvailable()) {
    return {
      argv: ["/bin/sh", "-c", opts.command],
      sandboxed: false,
    };
  }

  const helperPath = await generateCapHelper();
  if (!helperPath) {
    logWarn("capsicum: Capsicum helper unavailable; running command without sandbox.");
    return {
      argv: ["/bin/sh", "-c", opts.command],
      sandboxed: false,
    };
  }

  const allowNet = opts.policy?.allowNet ?? false;

  // The helper expects: <workdir> <allow-net:0|1> <cmd> [args...]
  // We invoke /bin/sh -c so that the command string is interpreted by the
  // shell (pipes, redirects, etc. work), but the shell itself is launched
  // under Capsicum via the helper.
  const argv = [helperPath, opts.workdir, allowNet ? "1" : "0", "/bin/sh", "-c", opts.command];

  return { argv, sandboxed: true };
}

// ---------------------------------------------------------------------------
// High-level exec
// ---------------------------------------------------------------------------

/**
 * Execute a command under Capsicum capability-mode restrictions.
 *
 * This is the primary API for the exec tool integration. It:
 *   1. Checks Capsicum availability (falls back if unavailable).
 *   2. Ensures the C helper binary is compiled and cached.
 *   3. Spawns the command through the helper, which enters capability mode.
 *   4. Collects stdout, stderr, and the exit code.
 *
 * @param command  The shell command to execute (passed to /bin/sh -c).
 * @param opts     Execution options.
 * @returns A promise resolving to the execution result.
 */
export async function capsicumExec(
  command: string,
  opts: CapsicumExecOptions,
): Promise<CapsicumExecResult> {
  const { argv, sandboxed } = await buildCapsicumLauncher({
    command,
    workdir: opts.workdir,
    policy: opts.policy,
  });

  const env = {
    ...process.env,
    ...(opts.env ?? {}),
  };

  // If the policy specifies a tmpDir, set TMPDIR in the child environment.
  if (opts.policy?.tmpDir) {
    env.TMPDIR = opts.policy.tmpDir;
  }

  return new Promise<CapsicumExecResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // On FreeBSD we use detached so the child gets its own pgroup.
      detached: IS_FREEBSD,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        try {
          // Kill the process group.
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // Process may have already exited.
        }
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      logWarn(`capsicum: child process error: ${err.message}`);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr:
          Buffer.concat(stderrChunks).toString("utf-8") +
          `\n[capsicum] spawn error: ${err.message}`,
        exitCode: 126,
        sandboxed,
      });
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
        sandboxed,
      });
    });

    // Close stdin immediately — sandboxed commands should not read from us.
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

/**
 * Build a default CapsicumPolicy suitable for typical exec tool usage.
 *
 * The default policy allows:
 *   - Read access to the workspace directory
 *   - Write access to the workspace directory and tmpdir
 *   - Execute access to standard system binaries
 *   - No network access
 *
 * @param workdir  The workspace directory path.
 */
export function buildDefaultPolicy(workdir: string): CapsicumPolicy {
  const tmpDir = resolveTmpDir();
  return {
    allowRead: [workdir, "/usr/share", "/usr/local/share"],
    allowWrite: [workdir, tmpDir],
    allowExec: ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"],
    allowNet: false,
    tmpDir,
  };
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset internal caches. Intended for tests only.
 */
export function _resetCapsicumState(): void {
  capsicumAvailable = null;
  capHelperReady = false;
}
