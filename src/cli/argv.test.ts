import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "freeclaw", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "freeclaw", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "freeclaw", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "freeclaw", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "freeclaw", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "freeclaw", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "freeclaw", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "freeclaw"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "freeclaw", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "freeclaw", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "freeclaw", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "freeclaw", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "freeclaw", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "freeclaw", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "freeclaw", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "freeclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "freeclaw", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "freeclaw", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "freeclaw", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "freeclaw", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "freeclaw", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "freeclaw", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node", "freeclaw", "status"],
    });
    expect(nodeArgv).toEqual(["node", "freeclaw", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node-22", "freeclaw", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "freeclaw", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node-22.2.0.exe", "freeclaw", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "freeclaw", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node-22.2", "freeclaw", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "freeclaw", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node-22.2.exe", "freeclaw", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "freeclaw", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["/usr/bin/node-22.2.0", "freeclaw", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "freeclaw", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["nodejs", "freeclaw", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "freeclaw", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["node-dev", "freeclaw", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "freeclaw", "node-dev", "freeclaw", "status"]);

    const directArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["freeclaw", "status"],
    });
    expect(directArgv).toEqual(["node", "freeclaw", "status"]);

    const bunArgv = buildParseArgv({
      programName: "freeclaw",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "freeclaw",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "freeclaw", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "freeclaw", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "freeclaw", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "freeclaw", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "freeclaw", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "freeclaw", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "freeclaw", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "freeclaw", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
