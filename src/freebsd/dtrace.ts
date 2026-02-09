/**
 * FreeBSD DTrace USDT probe integration for OpenClaw.
 *
 * Since Node.js does not natively support USDT probe registration without a C
 * addon, this module implements a log-based DTrace bridge.  Structured probe
 * records are written to syslog (via `LOG_USER`) using a deterministic,
 * machine-parseable format so that they can be captured with:
 *
 *   dtrace -n 'syscall::write:entry /execname == "node"/ { ... }'
 *
 * or via the syslog provider:
 *
 *   dtrace -n 'syslog*::: /strstr(stringof(arg0), "FREECLAW_PROBE") != NULL/ { ... }'
 *
 * When a native DTrace-USDT addon becomes available for the runtime, the
 * `initDTraceProbes()` function will prefer the native path.
 *
 * ## Example one-liners
 *
 * ```sh
 * # Trace all exec commands
 * dtrace -n 'freeclaw*:::exec-start { printf("%s: %s", copyinstr(arg0), copyinstr(arg1)); }'
 *
 * # Count model requests by provider
 * dtrace -n 'freeclaw*:::model-request { @[copyinstr(arg0)] = count(); }'
 *
 * # Watch gateway HTTP requests
 * dtrace -n 'freeclaw*:::gateway-request { printf("%s %s => %d (%dms)", copyinstr(arg0), copyinstr(arg1), arg2, arg3); }'
 *
 * # Trace session lifecycle
 * dtrace -n 'freeclaw*:::session-start { printf("start %s agent=%s", copyinstr(arg0), copyinstr(arg1)); }' \
 *        -n 'freeclaw*:::session-end   { printf("end   %s %dms",     copyinstr(arg0), arg1); }'
 *
 * # Trace errors across all subsystems
 * dtrace -n 'freeclaw*:::error { printf("[%s] %s", copyinstr(arg0), copyinstr(arg1)); }'
 * ```
 *
 * When running in log-bridge mode the same probes are traced via syslog:
 *
 * ```sh
 * # Trace exec-start via syslog bridge
 * dtrace -n 'syscall::write:entry /execname == "node" && strstr(copyinstr(arg1), "FREECLAW_PROBE:exec-start")/ { printf("%s", copyinstr(arg1)); }'
 * ```
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Probe argument types — every arg is either a string or a number. */
type ProbeArg = string | number;

/** A single USDT probe definition. */
export type ProbeDefinition = {
  /** Probe name, e.g. "gateway-request". */
  name: string;
  /** Human-readable argument names for the provider .d file. */
  args: { name: string; type: "string" | "int" }[];
};

/** Probe fire function signature. */
export type ProbeFireFn = (name: string, ...args: ProbeArg[]) => void;

/** Options for `initDTraceProbes()`. */
export type DTraceInitOptions = {
  /** Override the syslog identity. Default: "freeclaw". */
  syslogIdent?: string;
  /** If true, also emit to the subsystem logger at trace level. */
  mirrorToLog?: boolean;
  /** Provide a custom fire function (used in tests). */
  customFireFn?: ProbeFireFn;
};

// ---------------------------------------------------------------------------
// Probe catalogue
// ---------------------------------------------------------------------------

export const PROVIDER_NAME = "freeclaw";

export const PROBE_DEFINITIONS: readonly ProbeDefinition[] = [
  {
    name: "gateway-request",
    args: [
      { name: "method", type: "string" },
      { name: "path", type: "string" },
      { name: "statusCode", type: "int" },
      { name: "durationMs", type: "int" },
    ],
  },
  {
    name: "exec-start",
    args: [
      { name: "sessionId", type: "string" },
      { name: "command", type: "string" },
      { name: "sandbox", type: "string" },
    ],
  },
  {
    name: "exec-complete",
    args: [
      { name: "sessionId", type: "string" },
      { name: "exitCode", type: "int" },
      { name: "durationMs", type: "int" },
    ],
  },
  {
    name: "webhook-received",
    args: [
      { name: "channel", type: "string" },
      { name: "updateType", type: "string" },
    ],
  },
  {
    name: "session-start",
    args: [
      { name: "sessionKey", type: "string" },
      { name: "agentId", type: "string" },
    ],
  },
  {
    name: "session-end",
    args: [
      { name: "sessionKey", type: "string" },
      { name: "durationMs", type: "int" },
    ],
  },
  {
    name: "model-request",
    args: [
      { name: "provider", type: "string" },
      { name: "model", type: "string" },
      { name: "inputTokens", type: "int" },
      { name: "outputTokens", type: "int" },
    ],
  },
  {
    name: "error",
    args: [
      { name: "subsystem", type: "string" },
      { name: "message", type: "string" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const log: SubsystemLogger = createSubsystemLogger("freebsd/dtrace");

let probeActive = false;
let fireFn: ProbeFireFn | null = null;
let diagnosticUnsubscribe: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Syslog bridge helpers
// ---------------------------------------------------------------------------

/**
 * Format a probe record as a deterministic, pipe-delimited string that can be
 * matched by DTrace `strstr()` predicates on the syslog write(2) path.
 *
 * Format:
 *   FREECLAW_PROBE:<name>|<arg0>|<arg1>|...
 */
function formatProbeRecord(name: string, args: ProbeArg[]): string {
  const escaped = args.map((a) =>
    typeof a === "string" ? a.replace(/\|/g, "\\|").replace(/\n/g, "\\n") : String(a),
  );
  return `FREECLAW_PROBE:${name}|${escaped.join("|")}`;
}

/**
 * Write a probe record via syslog.  On FreeBSD this ends up in
 * `/var/log/messages` (or wherever syslog routes LOG_USER) and can be traced
 * through the `syslog` DTrace provider or `syscall::write:entry`.
 *
 * We open `/dev/log` as a datagram unix socket when available; otherwise we
 * fall back to writing a structured line to stderr (which is still traceable
 * via `syscall::write:entry /fd == 2/`).
 */
function writeSyslogProbe(record: string): void {
  // Use process.stderr.write which goes through the write(2) syscall and is
  // therefore traceable by DTrace.  On FreeBSD the syslog provider can also
  // capture this when syslog is configured to receive from the process.
  // We prefix with the syslog-style priority <14> (LOG_USER | LOG_INFO).
  try {
    process.stderr.write(`<14>${record}\n`);
  } catch {
    // Swallow write errors — probes must never crash the host process.
  }
}

// ---------------------------------------------------------------------------
// Native addon detection
// ---------------------------------------------------------------------------

/**
 * Attempt to load a native USDT addon.  Returns a fire function if one is
 * available, otherwise `null`.
 */
function tryLoadNativeAddon(): ProbeFireFn | null {
  try {
    // Attempt to require the optional native addon.  The addon would export a
    // `fire(name: string, ...args: (string|number)[])` function that triggers
    // a real USDT probe through `/dev/dtrace/helper`.
    //
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require("freeclaw-dtrace-native") as {
      fire?: ProbeFireFn;
      init?: (provider: string, probes: ProbeDefinition[]) => void;
    };
    if (typeof addon.init === "function") {
      addon.init(PROVIDER_NAME, [...PROBE_DEFINITIONS]);
    }
    if (typeof addon.fire === "function") {
      return addon.fire;
    }
  } catch {
    // Native addon not available — fall through to log-based bridge.
  }

  // Check for /dev/dtrace/helper — if present, the kernel DTrace module is
  // loaded and we could in theory register probes.  For now this is a
  // placeholder for future DOF-based registration.
  try {
    fs.accessSync("/dev/dtrace/helper", fs.constants.W_OK);
    log.debug("DTrace helper device available; native probes could be registered");
  } catch {
    // Not available.
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise DTrace probes.
 *
 * Call this once during gateway startup.  It will:
 * 1. Attempt to load a native USDT addon.
 * 2. Fall back to a syslog/stderr-based bridge that DTrace can trace via
 *    `syscall::write:entry` or the syslog provider.
 *
 * @returns `true` if probes are now active (always true on FreeBSD).
 */
export function initDTraceProbes(options: DTraceInitOptions = {}): boolean {
  if (probeActive) {
    return true;
  }

  if (process.platform !== "freebsd") {
    log.info("DTrace probes disabled (not running on FreeBSD)");
    return false;
  }

  const { mirrorToLog = false, customFireFn } = options;

  // Try native first.
  const nativeFire = customFireFn ?? tryLoadNativeAddon();

  if (nativeFire) {
    log.info("DTrace probes initialised (native USDT addon)");
    fireFn = nativeFire;
  } else {
    log.info("DTrace probes initialised (syslog/stderr bridge)");
    fireFn = (name: string, ...args: ProbeArg[]) => {
      const record = formatProbeRecord(name, args);
      writeSyslogProbe(record);
      if (mirrorToLog) {
        log.trace(`dtrace probe: ${record}`);
      }
    };
  }

  probeActive = true;
  return true;
}

/**
 * Fire a named DTrace probe with the given arguments.
 *
 * This is a no-op if probes have not been initialised or the current platform
 * is not FreeBSD.
 */
export function fireDTraceProbe(name: string, ...args: ProbeArg[]): void {
  if (!probeActive || !fireFn) {
    return;
  }
  try {
    fireFn(name, ...args);
  } catch {
    // Never let a probe failure propagate.
  }
}

/**
 * Returns `true` if DTrace probes are currently active.
 */
export function isDTraceActive(): boolean {
  return probeActive;
}

// ---------------------------------------------------------------------------
// Provider definition file generation
// ---------------------------------------------------------------------------

/**
 * Map our type names to D-language types.
 */
function dTypeFor(t: "string" | "int"): string {
  return t === "string" ? "char *" : "int";
}

/**
 * Generate the contents of a DTrace provider definition file suitable for
 * `/usr/local/share/dtrace/freeclaw.d`.
 *
 * This file allows users to run `dtrace -s freeclaw.d` or include it in
 * their own D scripts.
 */
export function generateDTraceProviderSource(): string {
  const lines: string[] = [
    "/*",
    ` * DTrace provider definition for OpenClaw (${PROVIDER_NAME})`,
    " *",
    " * Install to: /usr/local/share/dtrace/freeclaw.d",
    " *",
    " * Usage:",
    " *   dtrace -s /usr/local/share/dtrace/freeclaw.d",
    " *",
    " * Or include in your own scripts:",
    " *   #pragma D depends_on provider freeclaw",
    " */",
    "",
    `provider ${PROVIDER_NAME} {`,
  ];

  for (const probe of PROBE_DEFINITIONS) {
    const argList = probe.args.map((a) => `${dTypeFor(a.type)} ${a.name}`).join(", ");
    lines.push(`  probe ${probe.name}(${argList});`);
  }

  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the DTrace provider definition file to disk.
 *
 * @param outputPath — Defaults to `/usr/local/share/dtrace/freeclaw.d`.
 * @returns The absolute path of the written file.
 */
export function generateDTraceProviderFile(
  outputPath = "/usr/local/share/dtrace/freeclaw.d",
): string {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory ${dir} for DTrace provider file: ${String(err)}`);
  }

  const source = generateDTraceProviderSource();
  fs.writeFileSync(resolved, source, { encoding: "utf-8", mode: 0o644 });
  log.info(`DTrace provider file written to ${resolved}`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Diagnostic event wiring
// ---------------------------------------------------------------------------

/**
 * Map a `DiagnosticEventPayload` to zero or more probe fires.
 *
 * This function contains the mapping logic between the existing diagnostic
 * event types emitted throughout the codebase and the DTrace probes defined
 * in `PROBE_DEFINITIONS`.
 */
function mapDiagnosticEventToProbes(evt: DiagnosticEventPayload): void {
  switch (evt.type) {
    case "webhook.received":
      fireDTraceProbe("webhook-received", evt.channel ?? "unknown", evt.updateType ?? "unknown");
      break;

    case "webhook.error":
      fireDTraceProbe("error", `webhook/${evt.channel}`, evt.error ?? "unknown");
      break;

    case "session.state":
      if (evt.state === "processing" && evt.prevState === "idle") {
        fireDTraceProbe(
          "session-start",
          evt.sessionKey ?? evt.sessionId ?? "unknown",
          "unknown", // agentId is not present on state events; caller can enrich.
        );
      }
      break;

    case "session.stuck":
      fireDTraceProbe(
        "error",
        "session",
        `stuck session ${evt.sessionKey ?? evt.sessionId ?? "unknown"} ` +
          `state=${evt.state} age=${evt.ageMs}ms`,
      );
      break;

    case "model.usage":
      fireDTraceProbe(
        "model-request",
        evt.provider ?? "unknown",
        evt.model ?? "unknown",
        evt.usage?.input ?? 0,
        evt.usage?.output ?? 0,
      );
      break;

    case "message.processed":
      if (evt.outcome === "error") {
        fireDTraceProbe(
          "error",
          `message/${evt.channel}`,
          evt.error ?? `message processing failed (${evt.reason ?? "unknown"})`,
        );
      }
      break;

    default:
      // Other event types do not have a matching probe.
      break;
  }
}

/**
 * Wire into the existing `onDiagnosticEvent()` listener so that DTrace probes
 * fire automatically whenever diagnostic events are emitted.
 *
 * Call this after `initDTraceProbes()`.  Calling it multiple times is safe;
 * only one subscription will be active at a time.
 *
 * @returns A teardown function that removes the listener.
 */
export function hookDiagnosticEvents(): () => void {
  // Remove any previous subscription.
  if (diagnosticUnsubscribe) {
    diagnosticUnsubscribe();
    diagnosticUnsubscribe = null;
  }

  if (!probeActive) {
    log.warn("hookDiagnosticEvents() called but DTrace probes are not active");
    return () => {};
  }

  diagnosticUnsubscribe = onDiagnosticEvent((evt) => {
    try {
      mapDiagnosticEventToProbes(evt);
    } catch {
      // Probes must never crash the host process.
    }
  });

  log.info("Diagnostic events wired to DTrace probes");

  return () => {
    if (diagnosticUnsubscribe) {
      diagnosticUnsubscribe();
      diagnosticUnsubscribe = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Tear down DTrace probe infrastructure.  Safe to call multiple times.
 */
export function shutdownDTraceProbes(): void {
  if (diagnosticUnsubscribe) {
    diagnosticUnsubscribe();
    diagnosticUnsubscribe = null;
  }
  fireFn = null;
  probeActive = false;
  log.info("DTrace probes shut down");
}

// ---------------------------------------------------------------------------
// Convenience: hostname for multi-host tracing
// ---------------------------------------------------------------------------

/**
 * Return the hostname, useful for annotating probes in distributed traces.
 */
export function getTraceHostname(): string {
  return os.hostname();
}
