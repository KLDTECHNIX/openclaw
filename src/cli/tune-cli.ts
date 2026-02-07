/**
 * FreeBSD system tuning CLI — `freeclaw tune`.
 *
 * Wires the FreeBSD setup wizard into the Commander command tree.
 */
import type { Command } from "commander";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { defaultRuntime } from "../runtime.js";

export function registerTuneCli(program: Command) {
  program
    .command("tune")
    .description("FreeBSD system tuning wizard (sysctl, loader.conf, rc.conf, jails)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/platforms/freebsd", "docs.freeclaw.ai/platforms/freebsd")}\n`,
    )
    .option("--mode <mode>", "Wizard mode: full | tune-only | jail-only | audit", "full")
    .option("--non-interactive", "Run without prompts (audit mode implied)", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { runFreeBSDSetup } = await import("../freebsd/setup-wizard.js");
        const { createClackPrompter } = await import("../wizard/clack-prompter.js");
        const prompter = createClackPrompter();
        await runFreeBSDSetup(prompter, {
          mode: opts.mode,
          nonInteractive: Boolean(opts.nonInteractive),
        });
      });
    });
}
