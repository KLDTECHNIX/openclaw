import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";

const VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeForCompare(input: string, platform: NodeJS.Platform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(input).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function buildSystemNodeCandidates(
  _env: Record<string, string | undefined>,
  _platform: NodeJS.Platform,
): string[] {
  // FreeBSD: node is typically installed via pkg(8) to /usr/local/bin
  return ["/usr/local/bin/node", "/usr/bin/node"];
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

async function resolveNodeVersion(
  nodePath: string,
  execFileImpl: ExecFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export type SystemNodeInfo = {
  path: string;
  version: string | null;
  supported: boolean;
};

export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

export function isSystemNodePath(
  nodePath: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return buildSystemNodeCandidates(env, platform).some((candidate) => {
    const normalizedCandidate = normalizeForCompare(candidate, platform);
    return normalized === normalizedCandidate;
  });
}

export async function resolveSystemNodePath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates = buildSystemNodeCandidates(env, platform);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }
  return null;
}

export async function resolveSystemNodeInfo(params: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
}): Promise<SystemNodeInfo | null> {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const systemNode = await resolveSystemNodePath(env, platform);
  if (!systemNode) {
    return null;
  }

  const version = await resolveNodeVersion(systemNode, params.execFile ?? execFileAsync);
  return {
    path: systemNode,
    version,
    supported: isSupportedNodeVersion(version),
  };
}

export function renderSystemNodeWarning(
  systemNode: SystemNodeInfo | null,
  selectedNodePath?: string,
): string | null {
  if (!systemNode || systemNode.supported) {
    return null;
  }
  const versionLabel = systemNode.version ?? "unknown";
  const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
  return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22+.${selectedLabel} Install Node 22+ via pkg install node22.`;
}

export async function resolvePreferredNodePath(params: {
  env?: Record<string, string | undefined>;
  runtime?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
}): Promise<string | undefined> {
  if (params.runtime !== "node") {
    return undefined;
  }
  const systemNode = await resolveSystemNodeInfo(params);
  if (!systemNode?.supported) {
    return undefined;
  }
  return systemNode.path;
}
