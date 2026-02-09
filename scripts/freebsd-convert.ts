#!/usr/bin/env bun
/**
 * scripts/freebsd-convert.ts — Automated upstream-to-FreeClaw conversion engine.
 *
 * This script transforms the openclaw codebase into a FreeBSD-native FreeClaw fork.
 * It is idempotent — running it multiple times produces the same result.
 *
 * Transforms applied (in order):
 *   1. Environment variables:  OPENCLAW_* → FREECLAW_*
 *   2. State directories:      .openclaw  → .freeclaw
 *   3. Config files:           openclaw.json → freeclaw.json
 *   4. CLI commands:           openclaw → freeclaw (in user-facing strings)
 *   5. User-facing branding:   "OpenClaw" → "FreeClaw" (strings only, not types)
 *   6. Docker/sandbox labels:  openclaw.* → freeclaw.*
 *   7. URLs:                   openclaw.ai → freeclaw.ai, github.com/openclaw → github.com/freeclaw
 *   8. Platform guards:        process.platform === "freebsd" coalescing
 *   9. Package identity:       name, bin, description in package.json
 *
 * What is NOT changed (by design):
 *   - TypeScript type/interface/class names (OpenClawConfig, etc.) — internal identifiers
 *   - Import paths (from "./openclaw-tools.js") — these are filenames on disk
 *   - Files in node_modules/
 *   - Test fixture strings that test the conversion itself
 *
 * Run:
 *   bun scripts/freebsd-convert.ts
 *   bun scripts/freebsd-convert.ts --dry-run
 *   bun scripts/freebsd-convert.ts --verbose
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

// ── File discovery ────────────────────────────────────────────────────────────

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo", ".cache"]);

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// ── Transform definitions ─────────────────────────────────────────────────────

type Transform = {
  name: string;
  /** Regex to match. Must have the global flag. */
  pattern: RegExp;
  /** Replacement string (supports $1, $2 backrefs). */
  replacement: string;
  /** Optional: only apply to files matching this glob. */
  fileFilter?: (filePath: string) => boolean;
  /** Optional: skip if the line matches this pattern (avoids clobbering import paths). */
  skipLinePattern?: RegExp;
};

const isSourceFile = (f: string) => f.endsWith(".ts") || f.endsWith(".tsx");
const isNotTestFile = (f: string) => !f.includes(".test.") && !f.includes("__tests__");
const isSourceOrMd = (f: string) => isSourceFile(f) || f.endsWith(".md");

const transforms: Transform[] = [
  // ── 1. Environment variables ────────────────────────────────────────────
  {
    name: "env-vars",
    pattern: /\bOPENCLAW_/g,
    replacement: "FREECLAW_",
    fileFilter: isSourceOrMd,
  },

  // ── 2. State directory (.openclaw → .freeclaw) ──────────────────────────
  // Match .openclaw in strings, but NOT import paths like types.openclaw.js
  {
    name: "state-dir",
    pattern: /(["`'])\.openclaw\b/g,
    replacement: "$1.freeclaw",
    fileFilter: isSourceFile,
    skipLinePattern: /from\s+["']|import\s*\(/,
  },
  {
    name: "state-dir-template",
    pattern: /\$\{[^}]*\}\/\.openclaw\b/g,
    replacement: (match: string) => match.replace(".openclaw", ".freeclaw"),
    fileFilter: isSourceFile,
  } as unknown as Transform,
  // Plain path references in markdown
  {
    name: "state-dir-md",
    pattern: /~\/\.openclaw\b/g,
    replacement: "~/.freeclaw",
    fileFilter: (f) => f.endsWith(".md"),
  },

  // ── 3. Config file name ─────────────────────────────────────────────────
  {
    name: "config-file",
    pattern: /\bopenclaw\.json\b/g,
    replacement: "freeclaw.json",
    fileFilter: isSourceOrMd,
    skipLinePattern: /from\s+["']|import\s*\(/,
  },

  // ── 4. CLI command references (user-facing strings) ─────────────────────
  // Match "openclaw " in strings (CLI invocations), but not import paths.
  {
    name: "cli-command",
    pattern: /(?<=["'`])openclaw(?=\s)/g,
    replacement: "freeclaw",
    fileFilter: isSourceFile,
  },
  // Match `openclaw` in markdown code blocks
  {
    name: "cli-command-md",
    pattern: /(?<=^|\s)openclaw(?=\s)/gm,
    replacement: "freeclaw",
    fileFilter: (f) => f.endsWith(".md"),
  },

  // ── 5. User-facing branding ─────────────────────────────────────────────
  // "OpenClaw" in string literals → "FreeClaw"
  // Carefully avoid type names: OpenClawConfig, OpenClawTools, etc.
  {
    name: "branding-strings",
    pattern: /(?<=["'`\s(])OpenClaw(?=["'`\s),.:!?])/g,
    replacement: "FreeClaw",
    fileFilter: isSourceOrMd,
    skipLinePattern: /from\s+["']|import\s*\(|type\s+|interface\s+|class\s+/,
  },

  // ── 6. Docker/sandbox labels ────────────────────────────────────────────
  {
    name: "docker-labels",
    pattern: /\bopenclaw\.(sandbox|sessionKey|configHash|agentId|workspace)/g,
    replacement: "freeclaw.$1",
    fileFilter: isSourceFile,
  },
  {
    name: "docker-prefix",
    pattern: /\bopenclaw-sandbox\b/g,
    replacement: "freeclaw-sandbox",
    fileFilter: isSourceFile,
  },
  {
    name: "docker-sbx",
    pattern: /\bopenclaw-sbx-/g,
    replacement: "freeclaw-sbx-",
    fileFilter: isSourceFile,
  },

  // ── 7. URLs ─────────────────────────────────────────────────────────────
  {
    name: "url-domain",
    pattern: /\bopenclaw\.ai\b/g,
    replacement: "freeclaw.ai",
    fileFilter: isSourceOrMd,
    skipLinePattern: /from\s+["']|import\s*\(/,
  },
  {
    name: "url-github",
    pattern: /github\.com\/openclaw\/openclaw/g,
    replacement: "github.com/freeclaw/freeclaw",
    fileFilter: isSourceOrMd,
  },

  // ── 8. Service management strings ───────────────────────────────────────
  {
    name: "launchd-systemd-help",
    pattern: /\(launchd\/systemd\/schtasks\)/g,
    replacement: "(rc.d service)",
    fileFilter: isSourceFile,
  },
  {
    name: "launchd-systemd-help-alt",
    pattern: /launchd\/systemd\/schtasks/g,
    replacement: "rc.d service",
    fileFilter: isSourceFile,
    skipLinePattern: /from\s+["']|import\s*\(/,
  },

  // ── 9. package.json identity ────────────────────────────────────────────
  {
    name: "pkg-name",
    pattern: /"name":\s*"openclaw"/g,
    replacement: '"name": "freeclaw"',
    fileFilter: (f) => f.endsWith("package.json"),
  },
  {
    name: "pkg-bin",
    pattern: /"openclaw":\s*"openclaw\.mjs"/g,
    replacement: '"freeclaw": "freeclaw.mjs"',
    fileFilter: (f) => f.endsWith("package.json"),
  },

  // ── 10. localStorage key ────────────────────────────────────────────────
  {
    name: "localstorage",
    pattern: /openclaw\.control\.settings/g,
    replacement: "freeclaw.control.settings",
    fileFilter: isSourceFile,
  },

  // ── 11. npm/pkg install hints ───────────────────────────────────────────
  {
    name: "npm-install",
    pattern: /npm install -g openclaw\b/g,
    replacement: "npm install -g freeclaw",
    fileFilter: isSourceOrMd,
  },
  {
    name: "npm-uninstall",
    pattern: /npm uninstall -g openclaw\b/g,
    replacement: "npm uninstall -g freeclaw",
    fileFilter: isSourceOrMd,
  },

  // ── 12. File renames (import path fixups) ─────────────────────────────────
  // systemd-hints.ts was renamed to rcd-hints.ts
  {
    name: "import-rcd-hints",
    pattern: /systemd-hints\.js/g,
    replacement: "rcd-hints.js",
    fileFilter: isSourceFile,
  },

  // ── 13. Stale platform-specific strings ───────────────────────────────────
  {
    name: "launchd-compat",
    pattern: /for launchd compatibility/g,
    replacement: "for rc.d service compatibility",
    fileFilter: isSourceFile,
  },
  {
    name: "lsof-comment",
    pattern: /whether lsof reports/g,
    replacement: "whether sockstat reports",
    fileFilter: isSourceFile,
  },
  {
    name: "launchd-systemd-schtasks-paren",
    pattern: /\(launchd\/systemd\/schtasks\)/g,
    replacement: "(rc.d service)",
    fileFilter: isSourceFile,
  },
];

// ── File renames ──────────────────────────────────────────────────────────────

const FILE_RENAMES: Array<{ from: string; to: string }> = [
  { from: "src/daemon/systemd-hints.ts", to: "src/daemon/rcd-hints.ts" },
];

function applyFileRenames() {
  for (const rename of FILE_RENAMES) {
    const fromPath = path.join(ROOT, rename.from);
    const toPath = path.join(ROOT, rename.to);
    if (fs.existsSync(fromPath) && !fs.existsSync(toPath)) {
      if (VERBOSE) console.log(`  [rename] ${rename.from} → ${rename.to}`);
      if (!DRY_RUN) fs.renameSync(fromPath, toPath);
    }
  }
}

// ── Apply transforms ──────────────────────────────────────────────────────────

applyFileRenames();

let totalFiles = 0;
let totalChanges = 0;

const files = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "docs")),
  ...walk(path.join(ROOT, "extensions")),
  path.join(ROOT, "package.json"),
  path.join(ROOT, "freeclaw.mjs"),
  path.join(ROOT, "README.md"),
].filter((f) => fs.existsSync(f));

for (const file of files) {
  let content = fs.readFileSync(file, "utf-8");
  let original = content;
  let fileChanges = 0;

  for (const transform of transforms) {
    if (transform.fileFilter && !transform.fileFilter(file)) continue;

    if (transform.skipLinePattern) {
      // Apply line-by-line, skipping lines that match the skip pattern.
      const lines = content.split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (transform.skipLinePattern.test(lines[i]!)) continue;
        const newLine = lines[i]!.replace(transform.pattern, transform.replacement);
        if (newLine !== lines[i]) {
          lines[i] = newLine;
          changed = true;
          fileChanges++;
        }
      }
      if (changed) content = lines.join("\n");
    } else {
      const newContent = content.replace(transform.pattern, transform.replacement);
      if (newContent !== content) {
        // Count replacements
        const diff = content.length - newContent.length;
        fileChanges += Math.max(1, Math.abs(diff));
        content = newContent;
      }
    }
  }

  if (content !== original) {
    totalFiles++;
    totalChanges += fileChanges;
    const relPath = path.relative(ROOT, file);
    if (VERBOSE) {
      console.log(`  [convert] ${relPath} (${fileChanges} changes)`);
    }
    if (!DRY_RUN) {
      fs.writeFileSync(file, content, "utf-8");
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log("");
if (DRY_RUN) {
  console.log(`[dry-run] Would update ${totalFiles} files.`);
} else if (totalFiles === 0) {
  console.log("[convert] Already converted — no changes needed.");
} else {
  console.log(`[convert] Updated ${totalFiles} files.`);
}
