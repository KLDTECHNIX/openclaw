import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import {
  forceFreePort,
  forceFreePortAndWait,
  listPortListeners,
  type PortProcess,
  parseSockstatOutput,
} from "./ports.js";

describe("gateway --force helpers", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("parses sockstat output into pid/command pairs", () => {
    const sample = [
      "USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS",
      "root     node       123   3  tcp4   *:18789               *:*",
      "www      python     456   4  tcp6   :::18789              :::*",
    ].join("\n");
    const parsed = parseSockstatOutput(sample);
    expect(parsed).toEqual<PortProcess[]>([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("skips header and blank lines in sockstat output", () => {
    const sample = [
      "USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS",
      "",
      "root     node       789   3  tcp4   *:18789               *:*",
      "",
    ].join("\n");
    const parsed = parseSockstatOutput(sample);
    expect(parsed).toEqual<PortProcess[]>([{ pid: 789, command: "node" }]);
  });

  it("returns empty list when sockstat finds nothing", () => {
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      const err = new Error("no matches");
      // @ts-expect-error partial
      err.status = 1; // sockstat exit 1 for no matches
      throw err;
    });
    expect(listPortListeners(18789)).toEqual([]);
  });

  it("throws when sockstat is missing", () => {
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      const err = new Error("not found");
      // @ts-expect-error partial
      err.code = "ENOENT";
      throw err;
    });
    expect(() => listPortListeners(18789)).toThrow(/sockstat not found/);
  });

  it("kills each listener and returns metadata", () => {
    const sockstatOutput = [
      "USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS",
      "root     node       42    3  tcp4   *:18789               *:*",
      "www      ssh        99    4  tcp4   *:18789               *:*",
    ].join("\n");
    (execFileSync as unknown as vi.Mock).mockReturnValue(sockstatOutput);
    const killMock = vi.fn();
    // @ts-expect-error override for test
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(execFileSync).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
  });

  it("retries until the port is free", async () => {
    vi.useFakeTimers();
    let call = 0;
    const sockstatWithListener = [
      "USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS",
      "root     node       42    3  tcp4   *:18789               *:*",
    ].join("\n");
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      call += 1;
      // 1st call: initial listeners to kill; 2nd call: still listed; 3rd call: gone.
      if (call <= 2) {
        return sockstatWithListener;
      }
      const err = new Error("no matches");
      // @ts-expect-error partial
      err.status = 1;
      throw err;
    });

    const killMock = vi.fn();
    // @ts-expect-error override for test
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      sigtermTimeoutMs: 400,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(res.killed).toEqual<PortProcess[]>([{ pid: 42, command: "node" }]);
    expect(res.escalatedToSigkill).toBe(false);
    expect(res.waitedMs).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it("escalates to SIGKILL if SIGTERM doesn't free the port", async () => {
    vi.useFakeTimers();
    let call = 0;
    const sockstatWithListener = [
      "USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS",
      "root     node       42    3  tcp4   *:18789               *:*",
    ].join("\n");
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      call += 1;
      // Keep showing the listener until after SIGKILL, then clear.
      if (call <= 6) {
        return sockstatWithListener;
      }
      const err = new Error("no matches");
      // @ts-expect-error partial
      err.status = 1;
      throw err;
    });

    const killMock = vi.fn();
    // @ts-expect-error override for test
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 800,
      intervalMs: 100,
      sigtermTimeoutMs: 300,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(42, "SIGKILL");
    expect(res.escalatedToSigkill).toBe(true);

    vi.useRealTimers();
  });
});
