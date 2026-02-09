/**
 * FreeBSD platform identity and helpers.
 *
 * Centralizes all platform detection so that upstream code that checks
 * `process.platform` against "linux" or "darwin" can be adapted to
 * FreeBSD ("freebsd") in one place.
 *
 * Node.js reports `process.platform === "freebsd"` on FreeBSD.
 * Many upstream checks for "linux" should also apply to FreeBSD since
 * both are POSIX-compliant Unix systems. This module provides helpers
 * that unify those checks.
 */

/** True on FreeBSD (the only supported platform for FreeClaw). */
export const IS_FREEBSD = process.platform === "freebsd";

/**
 * True on any Unix-like platform (FreeBSD, Linux, macOS).
 * Use this where the upstream code checks `!== "win32"`.
 */
export const IS_UNIX = process.platform !== "win32";

/**
 * True when the platform supports POSIX signals (SIGTERM, SIGHUP, etc.).
 * Equivalent to `!== "win32"` in upstream code.
 */
export const HAS_POSIX_SIGNALS = process.platform !== "win32";

/**
 * True when the platform uses `/home/*` user directories.
 * On FreeBSD this is the default (same as Linux).
 */
export const HAS_HOME_DIRS = process.platform === "freebsd" || process.platform === "linux";

/**
 * Resolve the correct home directory candidates for state integrity checks.
 * Upstream code checks `/Users` on darwin, `/home` on linux.
 * FreeBSD uses `/home` (same as Linux) plus `/usr/home` (common symlink target).
 */
export function resolveHomePrefixes(): string[] {
  if (process.platform === "freebsd") return ["/home", "/usr/home"];
  if (process.platform === "linux") return ["/home"];
  if (process.platform === "darwin") return ["/Users"];
  return [];
}

/**
 * Whether `open` / `xdg-open` is available for opening URLs.
 * On FreeBSD, xdg-open is available if xdg-utils is installed,
 * but in a headless jail it won't be.
 */
export function hasBrowserOpen(): boolean {
  // In a jail or headless server, there's no display.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * FreeBSD-specific temp directory. Prefers TMPDIR, falls back to /tmp.
 */
export function resolveTmpDir(): string {
  return process.env.TMPDIR ?? "/tmp";
}

/**
 * Whether we are running inside a FreeBSD jail.
 *
 * Checks `security.jail.jailed` sysctl.
 */
export function isInsideJail(): boolean {
  try {
    const { execSync } = require("node:child_process");
    const result = execSync("sysctl -n security.jail.jailed", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return result === "1";
  } catch {
    return false;
  }
}

/**
 * Get the FreeBSD version string (e.g., "15.0-RELEASE").
 */
export function getFreeBSDVersion(): string {
  try {
    const { execSync } = require("node:child_process");
    return execSync("freebsd-version", { encoding: "utf-8", timeout: 2000 }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Map upstream platform checks to FreeBSD equivalents.
 *
 * This table documents every `process.platform` check in the codebase
 * and how it should behave on FreeBSD:
 *
 * | Upstream check          | FreeBSD behavior           | Notes                          |
 * |-------------------------|----------------------------|--------------------------------|
 * | === "win32"             | false                      | Never true on FreeBSD          |
 * | === "darwin"            | false                      | Never true on FreeBSD          |
 * | === "linux"             | false (use IS_UNIX)        | FreeBSD reports "freebsd"      |
 * | !== "win32"             | true (same as upstream)    | Correct for detached, signals  |
 * | === "darwin" (browser)  | false (no macOS open cmd)  | Use xdg-open if DISPLAY set    |
 * | === "linux" (oauth)     | true-ish (treat as unix)   | Same xdg-open/dbus behavior    |
 * | credential stores       | "freebsd" → keytar or file | No macOS Keychain, no wincred  |
 */
