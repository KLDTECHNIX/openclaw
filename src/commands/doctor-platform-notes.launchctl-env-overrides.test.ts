import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { noteMacLaunchctlGatewayEnvOverrides } from "./doctor-platform-notes.js";

describe("noteMacLaunchctlGatewayEnvOverrides", () => {
  it("is a no-op on FreeBSD (does not call noteFn or getenv)", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "some-value");
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, {
      platform: "freebsd" as NodeJS.Platform,
      getenv,
      noteFn,
    });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("is a no-op even with darwin platform (launchctl logic removed)", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as OpenClawConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, {
      platform: "darwin",
      getenv,
      noteFn,
    });

    // The function is now a no-op regardless of platform
    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("is a no-op when called with no deps", async () => {
    const cfg = {} as OpenClawConfig;
    // Should not throw when called with minimal args
    await noteMacLaunchctlGatewayEnvOverrides(cfg);
  });
});
