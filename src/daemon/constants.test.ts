import { describe, expect, it } from "vitest";
import {
  formatGatewayServiceDescription,
  GATEWAY_RCD_SERVICE_NAME,
  resolveGatewayProfileSuffix,
  resolveGatewayRcdServiceName,
} from "./constants.js";

describe("resolveGatewayRcdServiceName", () => {
  it("returns default rc.d service name when no profile is set", () => {
    const result = resolveGatewayRcdServiceName();
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
    expect(result).toBe("freeclaw_gateway");
  });

  it("returns default rc.d service name when profile is undefined", () => {
    const result = resolveGatewayRcdServiceName(undefined);
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });

  it("returns default rc.d service name when profile is 'default'", () => {
    const result = resolveGatewayRcdServiceName("default");
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });

  it("returns default rc.d service name when profile is 'Default' (case-insensitive)", () => {
    const result = resolveGatewayRcdServiceName("Default");
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });

  it("returns default rc.d service name when profile is 'DEFAULT' (case-insensitive)", () => {
    const result = resolveGatewayRcdServiceName("DEFAULT");
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });

  it("returns profile-specific rc.d service name when profile is set", () => {
    const result = resolveGatewayRcdServiceName("dev");
    expect(result).toBe("freeclaw_gateway_dev");
  });

  it("returns profile-specific rc.d service name for custom profile", () => {
    const result = resolveGatewayRcdServiceName("production");
    expect(result).toBe("freeclaw_gateway_production");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewayRcdServiceName("  test  ");
    expect(result).toBe("freeclaw_gateway_test");
  });

  it("returns default rc.d service name for empty string profile", () => {
    const result = resolveGatewayRcdServiceName("");
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });

  it("returns default rc.d service name for whitespace-only profile", () => {
    const result = resolveGatewayRcdServiceName("   ");
    expect(result).toBe(GATEWAY_RCD_SERVICE_NAME);
  });
});

describe("resolveGatewayProfileSuffix", () => {
  it("returns empty string when no profile is set", () => {
    expect(resolveGatewayProfileSuffix()).toBe("");
  });

  it("returns empty string for default profiles", () => {
    expect(resolveGatewayProfileSuffix("default")).toBe("");
    expect(resolveGatewayProfileSuffix(" Default ")).toBe("");
  });

  it("returns an underscore suffix for custom profiles", () => {
    expect(resolveGatewayProfileSuffix("dev")).toBe("_dev");
  });

  it("trims whitespace from profiles", () => {
    expect(resolveGatewayProfileSuffix("  staging  ")).toBe("_staging");
  });
});

describe("formatGatewayServiceDescription", () => {
  it("returns default description when no profile/version", () => {
    expect(formatGatewayServiceDescription()).toBe("FreeClaw Gateway");
  });

  it("includes profile when set", () => {
    expect(formatGatewayServiceDescription({ profile: "work" })).toBe(
      "FreeClaw Gateway (profile: work)",
    );
  });

  it("includes version when set", () => {
    expect(formatGatewayServiceDescription({ version: "2026.1.10" })).toBe(
      "FreeClaw Gateway (v2026.1.10)",
    );
  });

  it("includes profile and version when set", () => {
    expect(formatGatewayServiceDescription({ profile: "dev", version: "1.2.3" })).toBe(
      "FreeClaw Gateway (profile: dev, v1.2.3)",
    );
  });
});
