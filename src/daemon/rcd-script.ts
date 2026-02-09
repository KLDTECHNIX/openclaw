/**
 * FreeBSD rc.d script generation for the FreeClaw gateway daemon.
 *
 * Generates a proper /usr/local/etc/rc.d/ script that integrates with
 * FreeBSD's rc(8) system. The script follows the standard rc.subr(8) pattern.
 */

const SHEBANG = "#!/bin/sh";

function shellEscape(value: string): string {
  if (!/[\s"'\\$`!#&|;()<>]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

export type RcdScriptOptions = {
  /** rc.d service name (e.g. "freeclaw_gateway") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Full path to the executable (e.g. /usr/local/bin/node) */
  command: string;
  /** Arguments to pass after the command */
  commandArgs?: string[];
  /** Working directory */
  workingDirectory?: string;
  /** Environment variables to set */
  environment?: Record<string, string | undefined>;
  /** User to run as (defaults to daemon user) */
  runAsUser?: string;
  /** PID file path */
  pidFile?: string;
  /** Log file path (stdout/stderr redirect) */
  logFile?: string;
  /** rc.d REQUIRE dependencies (e.g. ["NETWORKING", "DAEMON"]) */
  require?: string[];
};

export function buildRcdScript(opts: RcdScriptOptions): string {
  const name = opts.name;
  const desc = opts.description ?? "FreeClaw Gateway";
  const require = opts.require ?? ["NETWORKING", "DAEMON"];
  const pidFile = opts.pidFile ?? `/var/run/${name}.pid`;
  const logFile = opts.logFile ?? `/var/log/${name}.log`;
  const user = opts.runAsUser ?? "root";

  const commandArgs = opts.commandArgs?.map(shellEscape).join(" ") ?? "";

  const envLines: string[] = [];
  if (opts.environment) {
    for (const [key, value] of Object.entries(opts.environment)) {
      if (typeof value === "string" && value.trim()) {
        envLines.push(`export ${key}=${shellEscape(value.trim())}`);
      }
    }
  }

  const envBlock =
    envLines.length > 0
      ? `\n${name}_env()\n{\n${envLines.map((l) => `\t${l}`).join("\n")}\n}\n`
      : "";

  const workDirLine = opts.workingDirectory
    ? `\n${name}_chdir="${shellEscape(opts.workingDirectory)}"`
    : "";

  return `${SHEBANG}

# PROVIDE: ${name}
# REQUIRE: ${require.join(" ")}
# KEYWORD: shutdown

. /etc/rc.subr

name="${name}"
rcvar="${name}_enable"

load_rc_config \${name}

: \${${name}_enable:="NO"}
: \${${name}_user:="${user}"}
: \${${name}_pidfile:="${pidFile}"}
: \${${name}_logfile:="${logFile}"}

pidfile="\${${name}_pidfile}"
command="${shellEscape(opts.command)}"
command_args="${commandArgs}"${workDirLine}
${envBlock}
start_cmd="${name}_start"
stop_cmd="${name}_stop"
status_cmd="${name}_status"
restart_cmd="${name}_restart"

${name}_start()
{
\tif checkyesno ${name}_enable; then
\t\techo "Starting \${name}."
\t\tif [ -n "\${${name}_chdir}" ]; then
\t\t\tcd "\${${name}_chdir}" || return 1
\t\tfi${envLines.length > 0 ? `\n\t\t${name}_env` : ""}
\t\t/usr/sbin/daemon -f -p "\${pidfile}" -o "\${${name}_logfile}" \\
\t\t\t-u "\${${name}_user}" \\
\t\t\t\${command} \${command_args}
\tfi
}

${name}_stop()
{
\tif [ -f "\${pidfile}" ]; then
\t\techo "Stopping \${name}."
\t\tkill -TERM \`cat "\${pidfile}"\` 2>/dev/null
\t\trm -f "\${pidfile}"
\telse
\t\techo "\${name} is not running."
\tfi
}

${name}_status()
{
\tif [ -f "\${pidfile}" ]; then
\t\tlocal pid
\t\tpid=\`cat "\${pidfile}" 2>/dev/null\`
\t\tif [ -n "\${pid}" ] && kill -0 "\${pid}" 2>/dev/null; then
\t\t\techo "\${name} is running as pid \${pid}."
\t\t\treturn 0
\t\telse
\t\t\techo "\${name} is not running (stale pidfile)."
\t\t\trm -f "\${pidfile}"
\t\t\treturn 1
\t\tfi
\telse
\t\techo "\${name} is not running."
\t\treturn 1
\tfi
}

${name}_restart()
{
\t${name}_stop
\tsleep 1
\t${name}_start
}

run_rc_command "$1"
`;
}

export function parseRcdScriptCommand(content: string): {
  command: string;
  commandArgs: string[];
} | null {
  const commandMatch = content.match(/^command="(.+)"$/m);
  if (!commandMatch) {
    return null;
  }
  const command = commandMatch[1]!;

  const argsMatch = content.match(/^command_args="(.*)"$/m);
  const rawArgs = argsMatch?.[1] ?? "";
  const commandArgs = rawArgs
    .split(/\s+/)
    .filter(Boolean)
    .map((arg) => {
      // Remove shell quotes
      if (arg.startsWith('"') && arg.endsWith('"')) {
        return arg.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      return arg;
    });

  return { command, commandArgs };
}

export function parseRcdScriptEnv(
  content: string,
  name: string,
): Record<string, string> | null {
  const envBlockRegex = new RegExp(`${name}_env\\(\\)\\s*\\{([^}]+)\\}`, "m");
  const match = content.match(envBlockRegex);
  if (!match) {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("export ")) {
      continue;
    }
    const assignment = trimmed.slice("export ".length);
    const eq = assignment.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = assignment.slice(0, eq);
    let value = assignment.slice(eq + 1);
    // Remove surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : null;
}
