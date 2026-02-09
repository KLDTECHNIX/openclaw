/** WSL is not applicable on FreeBSD — these stubs exist for import compatibility. */

export function isWSLEnv(): boolean {
  return false;
}

export async function isWSL(): Promise<boolean> {
  return false;
}
