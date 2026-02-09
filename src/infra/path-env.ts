import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTruthyEnvValue } from "./env.js";

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
};

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function mergePath(params: { existing: string; prepend: string[] }): string {
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = params.prepend.map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting]) {
    if (!seen.has(part)) {
      seen.add(part);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

function candidateBinDirs(opts: EnsureOpenClawPathOpts): string[] {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const candidates: string[] = [];

  // Check for freeclaw binary next to the executable
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "freeclaw");
    if (isExecutable(siblingCli)) {
      candidates.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs: node_modules/.bin/freeclaw near cwd
  const localBinDir = path.join(cwd, "node_modules", ".bin");
  if (isExecutable(path.join(localBinDir, "freeclaw"))) {
    candidates.push(localBinDir);
  }

  // mise version manager shims
  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) {
    candidates.push(miseShims);
  }

  if (process.env.XDG_BIN_HOME) {
    candidates.push(process.env.XDG_BIN_HOME);
  }
  candidates.push(path.join(homeDir, ".local", "bin"));
  candidates.push(path.join(homeDir, ".local", "share", "pnpm"));
  candidates.push(path.join(homeDir, ".bun", "bin"));
  candidates.push(path.join(homeDir, ".yarn", "bin"));
  // FreeBSD standard paths
  candidates.push("/usr/local/bin", "/usr/bin", "/bin");

  return candidates.filter(isDirectory);
}

/**
 * Best-effort PATH bootstrap so skills that require the `freeclaw` CLI can run
 * under rc.d/daemon(8) minimal environments.
 */
export function ensureFreeClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  if (isTruthyEnvValue(process.env.FREECLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  process.env.FREECLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  const prepend = candidateBinDirs(opts);
  if (prepend.length === 0) {
    return;
  }

  const merged = mergePath({ existing, prepend });
  if (merged) {
    process.env.PATH = merged;
  }
}
