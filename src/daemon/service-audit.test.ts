import { describe, expect, it } from "vitest";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "./service-audit.js";
import { buildMinimalServicePath } from "./service-env.js";

describe("auditGatewayServiceConfig", () => {
  it("flags bun runtime", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      command: {
        programArguments: ["/usr/local/bin/bun", "gateway"],
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    });
    expect(audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(
      true,
    );
  });

  it("flags version-managed node paths", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      command: {
        programArguments: ["/home/test/.nvm/versions/node/v22.0.0/bin/node", "gateway"],
        environment: {
          PATH: "/usr/local/bin:/usr/bin:/bin:/home/test/.nvm/versions/node/v22.0.0/bin",
        },
      },
    });
    expect(
      audit.issues.some(
        (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      ),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(true);
  });

  it("accepts FreeBSD minimal PATH", async () => {
    const env = { HOME: "/home/testuser" };
    const minimalPath = buildMinimalServicePath({ platform: "freebsd" as NodeJS.Platform, env });
    const audit = await auditGatewayServiceConfig({
      env,
      command: {
        programArguments: ["/usr/local/bin/node", "gateway"],
        environment: { PATH: minimalPath },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(false);
  });

  it("flags missing PATH", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      command: {
        programArguments: ["/usr/local/bin/node", "gateway"],
        environment: {},
      },
    });
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissing),
    ).toBe(true);
  });

  it("flags missing gateway subcommand", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      command: {
        programArguments: ["/usr/local/bin/node", "serve"],
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    });
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayCommandMissing),
    ).toBe(true);
  });

  it("reports no issues for a well-configured FreeBSD service", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/home/freeclaw" },
      command: {
        programArguments: ["/usr/local/bin/node", "gateway"],
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    });

    expect(audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(
      false,
    );
    expect(
      audit.issues.some(
        (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      ),
    ).toBe(false);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(false);
  });
});
