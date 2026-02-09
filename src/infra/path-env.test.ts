import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFreeClawCliOnPath } from "./path-env.js";

describe("ensureFreeClawCliOnPath", () => {
  it("prepends the bundled app bin dir when a sibling freeclaw exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freeclaw-path-"));
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const cliPath = path.join(appBinDir, "freeclaw");
      await fs.writeFile(cliPath, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(cliPath, 0o755);

      const originalPath = process.env.PATH;
      const originalFlag = process.env.FREECLAW_PATH_BOOTSTRAPPED;
      process.env.PATH = "/usr/local/bin:/usr/bin";
      delete process.env.FREECLAW_PATH_BOOTSTRAPPED;
      try {
        ensureFreeClawCliOnPath({
          execPath: cliPath,
          cwd: tmp,
          homeDir: tmp,
          platform: "freebsd" as NodeJS.Platform,
        });
        const updated = process.env.PATH ?? "";
        expect(updated.split(path.delimiter)[0]).toBe(appBinDir);
      } finally {
        process.env.PATH = originalPath;
        if (originalFlag === undefined) {
          delete process.env.FREECLAW_PATH_BOOTSTRAPPED;
        } else {
          process.env.FREECLAW_PATH_BOOTSTRAPPED = originalFlag;
        }
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const originalPath = process.env.PATH;
    const originalFlag = process.env.FREECLAW_PATH_BOOTSTRAPPED;
    process.env.PATH = "/usr/local/bin:/bin";
    process.env.FREECLAW_PATH_BOOTSTRAPPED = "1";
    try {
      ensureFreeClawCliOnPath({
        execPath: "/tmp/does-not-matter",
        cwd: "/tmp",
        homeDir: "/tmp",
        platform: "freebsd" as NodeJS.Platform,
      });
      expect(process.env.PATH).toBe("/usr/local/bin:/bin");
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.FREECLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.FREECLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
    }
  });

  it("prepends mise shims when available", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freeclaw-path-"));
    const originalPath = process.env.PATH;
    const originalFlag = process.env.FREECLAW_PATH_BOOTSTRAPPED;
    const originalMiseDataDir = process.env.MISE_DATA_DIR;
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const appCli = path.join(appBinDir, "freeclaw");
      await fs.writeFile(appCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(appCli, 0o755);

      const localBinDir = path.join(tmp, "node_modules", ".bin");
      await fs.mkdir(localBinDir, { recursive: true });
      const localCli = path.join(localBinDir, "freeclaw");
      await fs.writeFile(localCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(localCli, 0o755);

      const miseDataDir = path.join(tmp, "mise");
      const shimsDir = path.join(miseDataDir, "shims");
      await fs.mkdir(shimsDir, { recursive: true });
      process.env.MISE_DATA_DIR = miseDataDir;
      process.env.PATH = "/usr/local/bin:/usr/bin";
      delete process.env.FREECLAW_PATH_BOOTSTRAPPED;

      ensureFreeClawCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "freebsd" as NodeJS.Platform,
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      const appBinIndex = parts.indexOf(appBinDir);
      const localIndex = parts.indexOf(localBinDir);
      const shimsIndex = parts.indexOf(shimsDir);
      expect(appBinIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThan(appBinIndex);
      expect(shimsIndex).toBeGreaterThan(localIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.FREECLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.FREECLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
      if (originalMiseDataDir === undefined) {
        delete process.env.MISE_DATA_DIR;
      } else {
        process.env.MISE_DATA_DIR = originalMiseDataDir;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("includes /usr/local/bin in FreeBSD PATH candidates", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freeclaw-path-"));
    const originalPath = process.env.PATH;
    const originalFlag = process.env.FREECLAW_PATH_BOOTSTRAPPED;
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const appCli = path.join(appBinDir, "freeclaw");
      await fs.writeFile(appCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(appCli, 0o755);

      process.env.PATH = "/bin";
      delete process.env.FREECLAW_PATH_BOOTSTRAPPED;

      ensureFreeClawCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "freebsd" as NodeJS.Platform,
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      // /usr/local/bin should be included as a FreeBSD standard path
      expect(parts).toContain("/usr/local/bin");
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.FREECLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.FREECLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
