import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access },
  access: fsMocks.access,
}));

import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolvePreferredNodePath", () => {
  const freebsdNode = "/usr/local/bin/node";

  it("uses system node when it meets the minimum version", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === freebsdNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.12.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "freebsd" as NodeJS.Platform,
      execFile,
    });

    expect(result).toBe(freebsdNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("skips system node when it is too old", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === freebsdNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.11.x is below minimum 22.12.0
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.11.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "freebsd" as NodeJS.Platform,
      execFile,
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no system node is found", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn();

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "freebsd" as NodeJS.Platform,
      execFile,
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to /usr/bin/node when /usr/local/bin/node is missing", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === "/usr/bin/node") {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "freebsd" as NodeJS.Platform,
      execFile,
    });

    expect(result).toBe("/usr/bin/node");
  });
});

describe("resolveSystemNodeInfo", () => {
  const freebsdNode = "/usr/local/bin/node";

  it("returns supported info when version is new enough", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === freebsdNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.12.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "freebsd" as NodeJS.Platform,
      execFile,
    });

    expect(result).toEqual({
      path: freebsdNode,
      version: "22.12.0",
      supported: true,
    });
  });

  it("renders a warning when system node is too old", () => {
    const warning = renderSystemNodeWarning(
      {
        path: freebsdNode,
        version: "18.19.0",
        supported: false,
      },
      "/home/user/.nvm/versions/node/v22.0.0/bin/node",
    );

    expect(warning).toContain("below the required Node 22+");
    expect(warning).toContain(freebsdNode);
    expect(warning).toContain("pkg install node22");
  });
});
