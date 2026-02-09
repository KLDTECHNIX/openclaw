/**
 * FreeBSD-specific doctor platform notes.
 *
 * macOS LaunchAgent and launchctl checks are removed;
 * only legacy env-var detection remains.
 */
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

/** No-op on FreeBSD — LaunchAgent overrides are a macOS concept. */
export async function noteMacLaunchAgentOverrides() {
  // FreeBSD uses rc.d; nothing to check.
}

/** No-op on FreeBSD — launchctl env overrides are a macOS concept. */
export async function noteMacLaunchctlGatewayEnvOverrides(
  _cfg: OpenClawConfig,
  _deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
) {
  // FreeBSD uses rc.d; nothing to check.
}

export function noteDeprecatedLegacyEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { noteFn?: typeof note },
) {
  const entries = Object.entries(env)
    .filter(
      ([key, value]) =>
        (key.startsWith("MOLTBOT_") || key.startsWith("CLAWDBOT_")) && value?.trim(),
    )
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- Deprecated legacy environment variables detected (ignored).",
    "- Use FREECLAW_* equivalents instead:",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> FREECLAW_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "Environment");
}
