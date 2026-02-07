import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "freeclaw",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "freeclaw", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "freeclaw", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "freeclaw", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "freeclaw", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "freeclaw", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "freeclaw", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "freeclaw", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "freeclaw", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".freeclaw-dev");
    expect(env.FREECLAW_PROFILE).toBe("dev");
    expect(env.FREECLAW_STATE_DIR).toBe(expectedStateDir);
    expect(env.FREECLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "freeclaw.json"));
    expect(env.FREECLAW_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      FREECLAW_STATE_DIR: "/custom",
      FREECLAW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.FREECLAW_STATE_DIR).toBe("/custom");
    expect(env.FREECLAW_GATEWAY_PORT).toBe("19099");
    expect(env.FREECLAW_CONFIG_PATH).toBe(path.join("/custom", "freeclaw.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("freeclaw doctor --fix", {})).toBe("freeclaw doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("freeclaw doctor --fix", { FREECLAW_PROFILE: "default" })).toBe(
      "freeclaw doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("freeclaw doctor --fix", { FREECLAW_PROFILE: "Default" })).toBe(
      "freeclaw doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("freeclaw doctor --fix", { FREECLAW_PROFILE: "bad profile" })).toBe(
      "freeclaw doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("freeclaw --profile work doctor --fix", { FREECLAW_PROFILE: "work" }),
    ).toBe("freeclaw --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("freeclaw --dev doctor", { FREECLAW_PROFILE: "dev" })).toBe(
      "freeclaw --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("freeclaw doctor --fix", { FREECLAW_PROFILE: "work" })).toBe(
      "freeclaw --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("freeclaw doctor --fix", { FREECLAW_PROFILE: "  jbfreeclaw  " })).toBe(
      "freeclaw --profile jbfreeclaw doctor --fix",
    );
  });

  it("handles command with no args after freeclaw", () => {
    expect(formatCliCommand("freeclaw", { FREECLAW_PROFILE: "test" })).toBe(
      "freeclaw --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm freeclaw doctor", { FREECLAW_PROFILE: "work" })).toBe(
      "pnpm freeclaw --profile work doctor",
    );
  });
});
