/**
 * FreeBSD accept_filter(9) integration for OpenClaw.
 *
 * Accept filters are a FreeBSD kernel feature that delays delivery of an
 * incoming connection to userland until a certain condition is met:
 *
 * - **accf_http** (`httpready`): Waits until a full HTTP request header has
 *   been received.  This avoids waking the application for slow or partial
 *   requests, reducing context switches and improving throughput.
 *
 * - **accf_data** (`dataready`): Waits until at least one byte of data has
 *   arrived.  Useful for non-HTTP TCP services.
 *
 * Since Node.js does not expose `setsockopt(SO_ACCEPTFILTER)` directly, this
 * module compiles and caches a small C helper (`freeclaw-accf`) that takes a
 * file descriptor and filter name and applies the socket option.
 *
 * ## Usage
 *
 * ```ts
 * import { applyAcceptFilter, ensureAcceptFilterModules } from "./accept-filter.js";
 *
 * // At gateway startup, after httpServer.listen():
 * await ensureAcceptFilterModules();
 * applyAcceptFilter(httpServer, "httpready");
 * ```
 */

import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { type Server as HttpServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported accept_filter types. */
export type AcceptFilterType = "httpready" | "dataready";

/** Result of attempting to apply an accept filter. */
export type AcceptFilterResult = {
  ok: boolean;
  /** Human-readable message. */
  message: string;
  /** The filter that was applied, if successful. */
  filter?: AcceptFilterType;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log: SubsystemLogger = createSubsystemLogger("freebsd/accept-filter");

/**
 * Kernel module names for each filter type.
 */
const FILTER_KMOD: Record<AcceptFilterType, string> = {
  httpready: "accf_http",
  dataready: "accf_data",
};

/**
 * Directory where we cache the compiled helper binary.
 */
const HELPER_CACHE_DIR = path.join(os.tmpdir(), "freeclaw-accf");
const HELPER_BINARY_NAME = "freeclaw-accf";
const HELPER_BINARY_PATH = path.join(HELPER_CACHE_DIR, HELPER_BINARY_NAME);

/**
 * The C source for the accept-filter helper.
 *
 * This is a minimal program that takes two arguments:
 *   1. A file descriptor number (the listening socket).
 *   2. A filter name ("httpready" or "dataready").
 *
 * It calls setsockopt(fd, SOL_SOCKET, SO_ACCEPTFILTER, ...) and exits 0 on
 * success or 1 on failure (printing the error to stderr).
 */
const HELPER_C_SOURCE = `
/* freeclaw-accf: apply SO_ACCEPTFILTER to a socket fd. */
#include <sys/types.h>
#include <sys/socket.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#ifndef SO_ACCEPTFILTER
/* FreeBSD defines this in <sys/socket.h>; this is a safety fallback. */
#define SO_ACCEPTFILTER 0x1000
#endif

struct accept_filter_arg {
    char af_name[16];
    char af_arg[256 - 16];
};

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: freeclaw-accf <fd> <filter-name>\\n");
        return 1;
    }

    int fd = atoi(argv[1]);
    const char *filter = argv[2];

    if (fd < 0) {
        fprintf(stderr, "invalid fd: %d\\n", fd);
        return 1;
    }

    if (strlen(filter) >= 16) {
        fprintf(stderr, "filter name too long: %s\\n", filter);
        return 1;
    }

    struct accept_filter_arg afa;
    memset(&afa, 0, sizeof(afa));
    strncpy(afa.af_name, filter, sizeof(afa.af_name) - 1);

    if (setsockopt(fd, SOL_SOCKET, SO_ACCEPTFILTER, &afa, sizeof(afa)) < 0) {
        fprintf(stderr, "setsockopt(SO_ACCEPTFILTER, \\"%s\\"): %s\\n",
                filter, strerror(errno));
        return 1;
    }

    return 0;
}
`;

// ---------------------------------------------------------------------------
// Helper compilation
// ---------------------------------------------------------------------------

let helperCompiled = false;

/**
 * Ensure the C helper binary is compiled and cached.
 *
 * The binary is compiled once and reused for the lifetime of the process (and
 * across restarts, since it lives in /tmp).
 */
function ensureHelperCompiled(): boolean {
  if (helperCompiled) {
    return true;
  }

  // Check if already compiled from a previous run.
  try {
    fs.accessSync(HELPER_BINARY_PATH, fs.constants.X_OK);
    helperCompiled = true;
    return true;
  } catch {
    // Not yet compiled.
  }

  // Create cache directory.
  try {
    fs.mkdirSync(HELPER_CACHE_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    log.error(`Failed to create helper cache directory: ${String(err)}`);
    return false;
  }

  // Write the C source.
  const sourcePath = path.join(HELPER_CACHE_DIR, "freeclaw-accf.c");
  try {
    fs.writeFileSync(sourcePath, HELPER_C_SOURCE, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    log.error(`Failed to write helper source: ${String(err)}`);
    return false;
  }

  // Compile with the system C compiler.
  try {
    execSync(`cc -O2 -o ${HELPER_BINARY_PATH} ${sourcePath}`, {
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    fs.chmodSync(HELPER_BINARY_PATH, 0o700);
    helperCompiled = true;
    log.info(`Compiled accept-filter helper: ${HELPER_BINARY_PATH}`);
    return true;
  } catch (err) {
    log.error(`Failed to compile accept-filter helper: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Kernel module management
// ---------------------------------------------------------------------------

/**
 * Check whether a given accept_filter kernel module is loaded.
 */
function isKmodLoaded(kmod: string): boolean {
  try {
    const output = execSync("kldstat -v", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.includes(kmod);
  } catch {
    return false;
  }
}

/**
 * Check whether accept_filter support is available on this system.
 *
 * Returns `true` if at least one accept_filter module (accf_http or
 * accf_data) is loaded.
 */
export function isAcceptFilterAvailable(): boolean {
  if (process.platform !== "freebsd") {
    return false;
  }
  return isKmodLoaded("accf_http") || isKmodLoaded("accf_data");
}

/**
 * Ensure the required accept_filter kernel modules are loaded.
 *
 * This calls `kldload` for any module that is not already present.  Requires
 * root privileges or the `priv.kld_load` privilege in a jail.
 *
 * @returns An object indicating which modules were loaded.
 */
export function ensureAcceptFilterModules(): {
  loaded: string[];
  alreadyPresent: string[];
  errors: string[];
} {
  const result = {
    loaded: [] as string[],
    alreadyPresent: [] as string[],
    errors: [] as string[],
  };

  if (process.platform !== "freebsd") {
    result.errors.push("Not running on FreeBSD");
    return result;
  }

  for (const kmod of Object.values(FILTER_KMOD)) {
    if (isKmodLoaded(kmod)) {
      result.alreadyPresent.push(kmod);
      continue;
    }

    try {
      execSync(`kldload ${kmod}`, {
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      result.loaded.push(kmod);
      log.info(`Loaded kernel module: ${kmod}`);
    } catch (err) {
      const msg = `Failed to load kernel module ${kmod}: ${String(err)}`;
      result.errors.push(msg);
      log.warn(msg);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// File descriptor extraction
// ---------------------------------------------------------------------------

/**
 * Extract the underlying file descriptor from a Node.js HTTP server.
 *
 * Node.js does not publicly expose the fd, but we can access it through the
 * internal `_handle` property on the server's underlying TCP socket.
 */
function extractServerFd(server: HttpServer): number | null {
  // The server must be listening.
  if (!server.listening) {
    return null;
  }

  // Node.js internals: server._handle is a TCP or Pipe wrap with an `fd`
  // property (or `_handle.fd` on older versions).
  const handle = (server as unknown as Record<string, unknown>)._handle as
    | { fd?: number; _handle?: { fd?: number } }
    | undefined;

  if (!handle) {
    return null;
  }

  // Try direct fd property.
  if (typeof handle.fd === "number" && handle.fd >= 0) {
    return handle.fd;
  }

  // Some Node versions nest the fd inside the native handle.
  if (handle._handle && typeof handle._handle.fd === "number" && handle._handle.fd >= 0) {
    return handle._handle.fd;
  }

  // Fallback: try to get fd from the address info.  On FreeBSD, we can query
  // with fstat or sockstat, but that is fragile.  Return null to signal
  // that we cannot determine the fd.
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply an accept filter to a listening HTTP server.
 *
 * The server **must** already be in the listening state (i.e., the `listening`
 * event has fired or `server.listening === true`).
 *
 * @param server     — The Node.js HTTP server.
 * @param filterName — The accept filter to apply: `"httpready"` or `"dataready"`.
 *
 * @returns A result indicating success or failure.
 */
export function applyAcceptFilter(
  server: HttpServer,
  filterName: AcceptFilterType,
): AcceptFilterResult {
  if (process.platform !== "freebsd") {
    return {
      ok: false,
      message: "accept_filter is only available on FreeBSD",
    };
  }

  if (!server.listening) {
    return {
      ok: false,
      message: "Server is not listening; accept_filter can only be applied to a listening socket",
    };
  }

  // Ensure the kernel module for this filter is loaded.
  const kmod = FILTER_KMOD[filterName];
  if (!isKmodLoaded(kmod)) {
    return {
      ok: false,
      message: `Kernel module ${kmod} is not loaded; run ensureAcceptFilterModules() first`,
    };
  }

  // Extract the fd.
  const fd = extractServerFd(server);
  if (fd === null) {
    return {
      ok: false,
      message: "Could not extract file descriptor from server; _handle.fd not available",
    };
  }

  // Ensure the helper binary is compiled.
  if (!ensureHelperCompiled()) {
    return {
      ok: false,
      message: "Failed to compile the accept-filter helper binary",
    };
  }

  // Invoke the helper.
  try {
    execFileSync(HELPER_BINARY_PATH, [String(fd), filterName], {
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : String(err);
    const msg = `setsockopt(SO_ACCEPTFILTER) failed: ${stderr}`;
    log.error(msg);
    return { ok: false, message: msg };
  }

  log.info(`Applied accept_filter "${filterName}" to server fd ${fd}`);
  return {
    ok: true,
    message: `accept_filter "${filterName}" applied successfully`,
    filter: filterName,
  };
}

/**
 * Convenience wrapper: apply `httpready` accept filter to a listening HTTP
 * server.  Logs warnings on failure but does not throw.
 *
 * Intended to be called right after `httpServer.listen()` resolves.
 */
export function applyHttpAcceptFilter(server: HttpServer): AcceptFilterResult {
  const result = applyAcceptFilter(server, "httpready");
  if (!result.ok) {
    log.warn(`Could not apply httpready accept filter: ${result.message}`);
  }
  return result;
}

/**
 * Convenience wrapper: apply `dataready` accept filter to a listening server.
 * Logs warnings on failure but does not throw.
 */
export function applyDataAcceptFilter(server: HttpServer): AcceptFilterResult {
  const result = applyAcceptFilter(server, "dataready");
  if (!result.ok) {
    log.warn(`Could not apply dataready accept filter: ${result.message}`);
  }
  return result;
}
