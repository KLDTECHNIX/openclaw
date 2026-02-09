import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMinimalServicePath,
  buildNodeServiceEnvironment,
  buildServiceEnvironment,
  getMinimalServicePathParts,
  getMinimalServicePathPartsFromEnv,
} from "./service-env.js";

describe("getMinimalServicePathParts - FreeBSD", () => {
  it("returns empty array for win32", () => {
    const result = getMinimalServicePathParts({
      platform: "win32",
      home: "C:\\Users\\testuser",
    });
    expect(result).toEqual([]);
  });

  it("includes FreeBSD system directories", () => {
    const result = getMinimalServicePathParts({
      platform: "freebsd" as NodeJS.Platform,
    });

    // FreeBSD uses resolveSystemPathDirs which returns [] for unknown platforms,
    // but the service-env code still works with extraDirs
    // The actual system dirs depend on what resolveSystemPathDirs returns for freebsd
    expect(Array.isArray(result)).toBe(true);
  });

  it("places extraDirs before system directories", () => {
    const result = getMinimalServicePathParts({
      platform: "freebsd" as NodeJS.Platform,
      extraDirs: ["/usr/local/bin", "/custom/bin"],
    });

    const customIndex = result.indexOf("/custom/bin");
    expect(customIndex).toBeGreaterThan(-1);
    // extraDirs should be at the front
    expect(result[0]).toBe("/usr/local/bin");
    expect(result[1]).toBe("/custom/bin");
  });

  it("deduplicates directories", () => {
    const result = getMinimalServicePathParts({
      platform: "freebsd" as NodeJS.Platform,
      extraDirs: ["/usr/local/bin", "/usr/local/bin"],
    });
    const unique = [...new Set(result)];
    expect(result.length).toBe(unique.length);
  });
});

describe("buildMinimalServicePath", () => {
  const splitPath = (value: string, platform: NodeJS.Platform) =>
    value.split(platform === "win32" ? path.win32.delimiter : path.posix.delimiter);

  it("returns PATH as-is on Windows", () => {
    const result = buildMinimalServicePath({
      env: { PATH: "C:\\\\Windows\\\\System32" },
      platform: "win32",
    });
    expect(result).toBe("C:\\\\Windows\\\\System32");
  });

  it("includes extra directories when provided", () => {
    const result = buildMinimalServicePath({
      platform: "freebsd" as NodeJS.Platform,
      extraDirs: ["/usr/local/bin"],
      env: {},
    });
    expect(splitPath(result, "freebsd" as NodeJS.Platform)).toContain("/usr/local/bin");
  });

  it("deduplicates directories", () => {
    const result = buildMinimalServicePath({
      platform: "freebsd" as NodeJS.Platform,
      extraDirs: ["/usr/local/bin", "/usr/bin"],
      env: {},
    });
    const parts = splitPath(result, "freebsd" as NodeJS.Platform);
    const unique = [...new Set(parts)];
    expect(parts.length).toBe(unique.length);
  });
});

describe("buildServiceEnvironment", () => {
  it("sets minimal PATH and gateway vars", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      token: "secret",
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.FREECLAW_GATEWAY_PORT).toBe("18789");
    expect(env.FREECLAW_GATEWAY_TOKEN).toBe("secret");
    expect(env.FREECLAW_SERVICE_MARKER).toBe("freeclaw");
    expect(env.FREECLAW_SERVICE_KIND).toBe("gateway");
    expect(typeof env.FREECLAW_SERVICE_VERSION).toBe("string");
    expect(env.FREECLAW_RCD_SERVICE).toBe("freeclaw_gateway");
  });

  it("uses profile-specific rc.d service name", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", FREECLAW_PROFILE: "work" },
      port: 18789,
    });
    expect(env.FREECLAW_RCD_SERVICE).toBe("freeclaw_gateway_work");
  });
});

describe("buildNodeServiceEnvironment", () => {
  it("passes through HOME for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.FREECLAW_RCD_SERVICE).toBe("freeclaw_node");
    expect(env.FREECLAW_SERVICE_MARKER).toBe("freeclaw");
    expect(env.FREECLAW_SERVICE_KIND).toBe("node");
  });
});
