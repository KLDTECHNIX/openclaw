import { formatCliCommand } from "../cli/command-format.js";

export function isRcdUnavailableDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("rc.d directory not") ||
    normalized.includes("service not found") ||
    normalized.includes("rc.d service not found")
  );
}

export function renderRcdUnavailableHints(): string[] {
  return [
    "rc.d services are unavailable; ensure /usr/local/etc/rc.d/ exists.",
    `In a jail, run the gateway in the foreground instead: \`${formatCliCommand("freeclaw gateway run")}\`.`,
    "Install as rc.d service: freeclaw gateway install",
  ];
}
