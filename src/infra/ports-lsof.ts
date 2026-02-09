/**
 * FreeBSD uses sockstat(1) natively. These stubs exist for import compatibility
 * with code that previously used lsof. The actual port inspection now uses
 * sockstat directly in ports-inspect.ts.
 */

/** @deprecated Use sockstat directly. Kept for import compatibility. */
export async function resolveLsofCommand(): Promise<string> {
  return "sockstat";
}

/** @deprecated Use sockstat directly. Kept for import compatibility. */
export function resolveLsofCommandSync(): string {
  return "sockstat";
}
