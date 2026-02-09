/**
 * FreeClaw FreeBSD Setup Wizard — TUI installer.
 *
 * Interactive setup that configures the host FreeBSD system for optimal
 * FreeClaw performance. Covers:
 *
 *   1. System audit (current sysctl, loader.conf, rc.conf state)
 *   2. Kernel tuning (sysctl.conf runtime knobs)
 *   3. Boot tuning (loader.conf kernel modules & params)
 *   4. Service configuration (rc.conf)
 *   5. Jail creation (optional isolated deployment)
 *   6. Apply & summary
 *
 * Uses the project's existing @clack/prompts-based wizard framework.
 *
 * Reference: FreeBSD Handbook, tuning(7), jail(8), rc.conf(5),
 *            sysctl.conf(5), loader.conf(5).
 */
import fs from "node:fs/promises";
import type { WizardPrompter } from "../wizard/prompts.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  type SysctlKnob,
  SYSCTL_KNOBS,
  auditSysctlKnobs,
  applySysctl,
  generateSysctlConf,
} from "./sysctl-tuning.js";
import {
  type LoaderTunable,
  LOADER_TUNABLES,
  auditLoaderTunables,
  generateLoaderConf,
} from "./loader-tuning.js";
import {
  type RcConfEntry,
  buildRecommendedRcConf,
  auditRcConf,
  setRcVar,
  generateRcConfSnippet,
} from "./rcconf-tuning.js";
import {
  type JailConfig,
  resolveDefaultJailConfig,
  nextJailIp,
  jailExistsInConf,
  generateJailConf,
  generateJailFstab,
  bootstrapJail,
} from "./jail.js";

export type SetupMode = "full" | "tune-only" | "jail-only" | "audit";

export type SetupOptions = {
  mode?: SetupMode;
  nonInteractive?: boolean;
};

/**
 * Run the FreeBSD setup wizard.
 */
export async function runFreeBSDSetup(
  prompter: WizardPrompter,
  opts: SetupOptions = {},
): Promise<void> {
  const mode = opts.mode ?? "full";

  await prompter.intro("FreeClaw FreeBSD Setup");

  await prompter.note(
    [
      "This wizard configures your FreeBSD system for optimal FreeClaw",
      "gateway performance. It can tune kernel parameters, configure",
      "boot-time modules, set up rc.conf, and create isolated jails.",
      "",
      "Some operations require root privileges. You will be prompted",
      "before any changes are written to disk.",
    ].join("\n"),
    "About",
  );

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) {
    await prompter.note(
      "You are not running as root. Some operations (writing to /etc, " +
        "/boot, creating jails) will require elevated privileges. " +
        "Consider running: sudo freeclaw setup",
      "Privileges",
    );
  }

  if (mode === "audit" || mode === "full") {
    await runAudit(prompter);
  }

  if (mode === "full" || mode === "tune-only") {
    await runSysctlTuning(prompter, isRoot);
    await runLoaderTuning(prompter, isRoot);
    await runRcConfTuning(prompter, isRoot, { enableJails: mode === "full" });
  }

  if (mode === "full" || mode === "jail-only") {
    await runJailSetup(prompter, isRoot);
  }

  await prompter.outro("FreeBSD setup complete. Enjoy FreeClaw.");
}

// ── Audit ────────────────────────────────────────────────────────────

async function runAudit(prompter: WizardPrompter): Promise<void> {
  const progress = prompter.progress("Auditing system configuration...");

  progress.update("Checking sysctl knobs...");
  const sysctlResults = await auditSysctlKnobs();
  const sysctlNeedsChange = sysctlResults.filter((r) => r.needsChange).length;

  progress.update("Checking loader.conf...");
  const loaderResults = await auditLoaderTunables();
  const loaderNeedsChange = loaderResults.filter((r) => r.needsChange).length;

  progress.update("Checking rc.conf...");
  const rcEntries = buildRecommendedRcConf();
  const rcResults = await auditRcConf(rcEntries);
  const rcNeedsChange = rcResults.filter((r) => r.needsChange).length;

  progress.stop("Audit complete.");

  const totalKnobs =
    sysctlResults.length + loaderResults.length + rcResults.length;
  const totalChanges = sysctlNeedsChange + loaderNeedsChange + rcNeedsChange;

  const lines: string[] = [
    `Checked ${totalKnobs} settings, ${totalChanges} need changes:`,
    "",
    `  sysctl.conf:  ${sysctlNeedsChange}/${sysctlResults.length} need tuning`,
    `  loader.conf:  ${loaderNeedsChange}/${loaderResults.length} need tuning`,
    `  rc.conf:      ${rcNeedsChange}/${rcResults.length} need tuning`,
  ];

  if (totalChanges === 0) {
    lines.push("", "System is already optimally configured for FreeClaw.");
  }

  await prompter.note(lines.join("\n"), "System Audit");

  // Show details for items needing change
  if (sysctlNeedsChange > 0) {
    const details = sysctlResults
      .filter((r) => r.needsChange)
      .map(
        (r) =>
          `  ${r.knob.key}: ${r.current ?? "(unset)"} -> ${r.recommended}`,
      );
    await prompter.note(details.join("\n"), "sysctl changes needed");
  }

  if (loaderNeedsChange > 0) {
    const details = loaderResults
      .filter((r) => r.needsChange)
      .map(
        (r) =>
          `  ${r.tunable.key}: ${r.current ?? "(unset)"} -> ${r.recommended}`,
      );
    await prompter.note(details.join("\n"), "loader.conf changes needed (reboot required)");
  }

  if (rcNeedsChange > 0) {
    const details = rcResults
      .filter((r) => r.needsChange)
      .map(
        (r) =>
          `  ${r.entry.key}: ${r.current ?? "(unset)"} -> ${r.recommended}`,
      );
    await prompter.note(details.join("\n"), "rc.conf changes needed");
  }
}

// ── sysctl.conf tuning ──────────────────────────────────────────────

async function runSysctlTuning(
  prompter: WizardPrompter,
  isRoot: boolean,
): Promise<void> {
  const results = await auditSysctlKnobs();
  const needsChange = results.filter((r) => r.needsChange);

  if (needsChange.length === 0) {
    await prompter.note("All sysctl knobs are already optimized.", "sysctl.conf");
    return;
  }

  const apply = await prompter.confirm({
    message: `Apply ${needsChange.length} sysctl tuning changes?`,
    initialValue: true,
  });

  if (!apply) return;

  // Let user pick categories
  const categories = [
    ...new Set(needsChange.map((r) => r.knob.category)),
  ] as const;

  const selectedCategories = await prompter.multiselect({
    message: "Select tuning categories to apply",
    options: categories.map((cat) => ({
      value: cat,
      label: cat.toUpperCase(),
      hint: `${needsChange.filter((r) => r.knob.category === cat).length} changes`,
    })),
    initialValues: [...categories],
  });

  const selectedKnobs = needsChange
    .filter((r) => selectedCategories.includes(r.knob.category))
    .map((r) => r.knob);

  if (selectedKnobs.length === 0) return;

  // Apply at runtime
  const applyRuntime = await prompter.confirm({
    message: "Apply changes to running system now (sysctl)?",
    initialValue: true,
  });

  if (applyRuntime) {
    if (!isRoot) {
      await prompter.note(
        "Runtime sysctl changes require root. Skipping live apply.",
        "sysctl",
      );
    } else {
      const progress = prompter.progress("Applying sysctl changes...");
      let applied = 0;
      for (const knob of selectedKnobs) {
        if (knob.runtimeTunable) {
          const result = await applySysctl(knob.key, knob.value);
          if (result.ok) applied++;
        }
      }
      progress.stop(`Applied ${applied}/${selectedKnobs.length} sysctl changes.`);
    }
  }

  // Write to /etc/sysctl.conf
  const writePersistent = await prompter.confirm({
    message: "Write changes to /etc/sysctl.conf (persistent across reboots)?",
    initialValue: true,
  });

  if (writePersistent) {
    const content = generateSysctlConf(selectedKnobs);
    const confPath = "/etc/sysctl.conf.freeclaw";

    if (!isRoot) {
      await prompter.note(
        `Cannot write to /etc/sysctl.conf without root. Saved to:\n  ${confPath}\n\nMerge manually:\n  cat ${confPath} >> /etc/sysctl.conf`,
        "sysctl.conf",
      );
    }

    try {
      // Append to existing or write FreeClaw section
      const targetPath = isRoot ? "/etc/sysctl.conf" : confPath;
      let existing = "";
      try {
        existing = await fs.readFile(targetPath, "utf8");
      } catch {
        // File doesn't exist
      }

      // Remove any previous FreeClaw section
      const cleaned = existing.replace(
        /# FreeClaw gateway system tuning[\s\S]*?(?=\n#(?! FreeClaw)|$)/,
        "",
      );

      await fs.writeFile(targetPath, cleaned.trimEnd() + "\n\n" + content);
      await prompter.note(`Written to ${targetPath}`, "sysctl.conf");
    } catch (err) {
      await prompter.note(
        `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
        "sysctl.conf",
      );
    }
  }
}

// ── loader.conf tuning ──────────────────────────────────────────────

async function runLoaderTuning(
  prompter: WizardPrompter,
  isRoot: boolean,
): Promise<void> {
  const results = await auditLoaderTunables();
  const needsChange = results.filter((r) => r.needsChange);

  if (needsChange.length === 0) {
    await prompter.note("All loader.conf tunables are already set.", "loader.conf");
    return;
  }

  await prompter.note(
    `${needsChange.length} boot-time tunables need changes.\n` +
      "These require a reboot to take effect.",
    "loader.conf",
  );

  const apply = await prompter.confirm({
    message: `Write ${needsChange.length} loader.conf changes?`,
    initialValue: true,
  });

  if (!apply) return;

  const selectedTunables = await prompter.multiselect({
    message: "Select loader.conf tunables to apply",
    options: needsChange.map((r) => ({
      value: r.tunable,
      label: r.tunable.key,
      hint: r.tunable.description.slice(0, 60),
    })),
    initialValues: needsChange.map((r) => r.tunable),
  });

  if (selectedTunables.length === 0) return;

  const content = generateLoaderConf(selectedTunables);
  const targetPath = isRoot ? "/boot/loader.conf" : "/boot/loader.conf.freeclaw";

  try {
    let existing = "";
    try {
      existing = await fs.readFile(targetPath, "utf8");
    } catch {
      // File doesn't exist
    }

    const cleaned = existing.replace(
      /# FreeClaw gateway boot-time tuning[\s\S]*?(?=\n#(?! FreeClaw)|$)/,
      "",
    );

    await fs.writeFile(targetPath, cleaned.trimEnd() + "\n\n" + content);
    await prompter.note(
      `Written to ${targetPath}\n\nReboot required for these changes to take effect.`,
      "loader.conf",
    );
  } catch (err) {
    if (!isRoot) {
      await prompter.note(
        `Cannot write to /boot/loader.conf without root.\n\nGenerated content:\n\n${content}`,
        "loader.conf",
      );
    } else {
      await prompter.note(
        `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
        "loader.conf",
      );
    }
  }
}

// ── rc.conf tuning ──────────────────────────────────────────────────

async function runRcConfTuning(
  prompter: WizardPrompter,
  isRoot: boolean,
  rcOpts: { enableJails?: boolean },
): Promise<void> {
  const entries = buildRecommendedRcConf({ enableJails: rcOpts.enableJails });
  const results = await auditRcConf(entries);
  const needsChange = results.filter((r) => r.needsChange);

  if (needsChange.length === 0) {
    await prompter.note("All rc.conf settings are already configured.", "rc.conf");
    return;
  }

  const apply = await prompter.confirm({
    message: `Apply ${needsChange.length} rc.conf changes via sysrc(8)?`,
    initialValue: true,
  });

  if (!apply) return;

  const selectedEntries = await prompter.multiselect({
    message: "Select rc.conf entries to apply",
    options: needsChange.map((r) => ({
      value: r.entry,
      label: `${r.entry.key}="${r.entry.value}"`,
      hint: r.entry.description.slice(0, 50),
    })),
    initialValues: needsChange.map((r) => r.entry),
  });

  if (selectedEntries.length === 0) return;

  if (!isRoot) {
    const snippet = generateRcConfSnippet(selectedEntries);
    await prompter.note(
      `Cannot run sysrc(8) without root. Add these manually:\n\n${snippet}`,
      "rc.conf",
    );
    return;
  }

  const progress = prompter.progress("Applying rc.conf changes...");
  let applied = 0;
  for (const entry of selectedEntries) {
    const result = await setRcVar(entry.key, entry.value);
    if (result.ok) applied++;
  }
  progress.stop(`Applied ${applied}/${selectedEntries.length} rc.conf changes via sysrc(8).`);
}

// ── Jail setup ──────────────────────────────────────────────────────

async function runJailSetup(
  prompter: WizardPrompter,
  isRoot: boolean,
): Promise<void> {
  const createJail = await prompter.confirm({
    message: "Create a FreeBSD jail for isolated FreeClaw deployment?",
    initialValue: false,
  });

  if (!createJail) return;

  if (!isRoot) {
    await prompter.note(
      "Jail creation requires root. Run: sudo freeclaw setup",
      "Jail",
    );
    return;
  }

  // Jail name
  const jailName = await prompter.text({
    message: "Jail name",
    initialValue: "freeclaw0",
    placeholder: "freeclaw0",
    validate: (value) => {
      if (!value.trim()) return "Name is required";
      if (!/^[a-z][a-z0-9_-]*$/.test(value.trim())) {
        return "Must start with a-z, then a-z0-9_- only";
      }
      return undefined;
    },
  });

  // Check if jail already exists
  const exists = await jailExistsInConf(jailName);
  if (exists) {
    const overwrite = await prompter.confirm({
      message: `Jail "${jailName}" already exists in jail.conf. Overwrite?`,
      initialValue: false,
    });
    if (!overwrite) return;
  }

  // Jail IP
  const defaultIp = await nextJailIp();
  const jailIp = await prompter.text({
    message: "Jail IPv4 address (loopback alias)",
    initialValue: defaultIp,
    placeholder: defaultIp,
    validate: (value) => {
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.trim())) {
        return "Invalid IPv4 address";
      }
      return undefined;
    },
  });

  // Gateway port inside jail
  const portStr = await prompter.text({
    message: "FreeClaw gateway port inside jail",
    initialValue: "18789",
    placeholder: "18789",
    validate: (value) => {
      const num = Number.parseInt(value, 10);
      if (!Number.isFinite(num) || num < 1 || num > 65535) {
        return "Invalid port (1-65535)";
      }
      return undefined;
    },
  });
  const gatewayPort = Number.parseInt(portStr, 10);

  // Jail root directory
  const jailRoot = await prompter.text({
    message: "Jail root filesystem path",
    initialValue: `/usr/local/jails/${jailName}`,
    placeholder: `/usr/local/jails/${jailName}`,
  });

  const cfg = resolveDefaultJailConfig({
    name: jailName,
    ip4Addr: jailIp,
    gatewayPort,
    rootDir: jailRoot,
  });

  // Show summary before proceeding
  await prompter.note(
    [
      `Name:       ${cfg.name}`,
      `Root:       ${cfg.rootDir}`,
      `Hostname:   ${cfg.hostname}`,
      `IPv4:       ${cfg.ip4Addr} (on lo1)`,
      `Port:       ${cfg.gatewayPort}`,
      "",
      "This will:",
      "  - Extract base.txz into the jail root",
      "  - Install pkg(8), node22, and freeclaw",
      "  - Write jail.conf stanza to /etc/jail.conf",
      "  - Enable the jail in rc.conf",
    ].join("\n"),
    "Jail Configuration",
  );

  const proceed = await prompter.confirm({
    message: "Proceed with jail creation?",
    initialValue: true,
  });

  if (!proceed) return;

  // Write jail.conf
  const progress = prompter.progress("Creating jail...");

  try {
    progress.update("Writing jail.conf...");
    const jailConfContent = generateJailConf(cfg);
    const jailConfPath = "/etc/jail.conf";
    let existingConf = "";
    try {
      existingConf = await fs.readFile(jailConfPath, "utf8");
    } catch {
      // Create fresh
    }

    // Remove existing stanza for this jail if present
    const stanzaRe = new RegExp(
      `\\n?${cfg.name}\\s*\\{[^}]*\\}`,
      "g",
    );
    existingConf = existingConf.replace(stanzaRe, "");
    await fs.writeFile(
      jailConfPath,
      existingConf.trimEnd() + "\n\n" + jailConfContent + "\n",
    );

    // Enable jail in rc.conf
    progress.update("Enabling jail in rc.conf...");
    await setRcVar("jail_enable", "YES");
    await setRcVar("cloned_interfaces", "lo1");

    // Add to jail_list
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    try {
      const { stdout } = await exec("sysrc", ["-n", "jail_list"], { encoding: "utf8" });
      const currentList = stdout.trim();
      if (!currentList.split(/\s+/).includes(cfg.name)) {
        await setRcVar("jail_list", `${currentList} ${cfg.name}`.trim());
      }
    } catch {
      await setRcVar("jail_list", cfg.name);
    }

    // Bootstrap the jail filesystem
    const bootstrapResult = await bootstrapJail(cfg, {
      onProgress: (msg) => progress.update(msg),
    });

    if (!bootstrapResult.ok) {
      progress.stop("Jail bootstrap failed.");
      await prompter.note(
        `Error: ${bootstrapResult.error}\n\nThe jail.conf entry was written. ` +
          `You can manually bootstrap with:\n  bsdinstall jail ${cfg.rootDir}`,
        "Jail Error",
      );
      return;
    }

    progress.stop("Jail created successfully.");
  } catch (err) {
    progress.stop("Jail creation failed.");
    await prompter.note(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      "Jail Error",
    );
    return;
  }

  await prompter.note(
    [
      `Jail "${cfg.name}" is ready.`,
      "",
      "Management commands:",
      `  service jail start ${cfg.name}     # Start the jail`,
      `  service jail stop ${cfg.name}      # Stop the jail`,
      `  jexec ${cfg.name} /bin/sh          # Shell into the jail`,
      `  jls                                # List running jails`,
      "",
      "The FreeClaw gateway will start automatically inside the jail.",
      `Access it at: http://${cfg.ip4Addr}:${cfg.gatewayPort}`,
    ].join("\n"),
    "Jail Ready",
  );
}
