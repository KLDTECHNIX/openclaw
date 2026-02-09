import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".freeclaw"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", FREECLAW_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".freeclaw-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", FREECLAW_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".freeclaw"));
  });

  it("uses FREECLAW_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", FREECLAW_STATE_DIR: "/var/lib/freeclaw" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/freeclaw"));
  });

  it("expands ~ in FREECLAW_STATE_DIR", () => {
    const env = { HOME: "/Users/test", FREECLAW_STATE_DIR: "~/freeclaw-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/freeclaw-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { FREECLAW_STATE_DIR: "C:\\State\\freeclaw" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\freeclaw");
  });
});
