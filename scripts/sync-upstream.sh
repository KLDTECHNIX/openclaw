#!/usr/bin/env bash
# scripts/sync-upstream.sh — Sync upstream openclaw/openclaw and convert to FreeClaw
#
# Usage:
#   scripts/sync-upstream.sh              # merge upstream/main, convert, commit
#   scripts/sync-upstream.sh --convert    # convert only (skip merge)
#   scripts/sync-upstream.sh --dry-run    # show what would change, no writes
#   scripts/sync-upstream.sh --audit      # count remaining Linux-isms
#
# This script is idempotent: running it twice produces the same result.
# It is the single source of truth for how upstream openclaw becomes FreeClaw on FreeBSD.
#
# Reference: FreeBSD Porter's Handbook, tuning(7), rc.subr(8)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Flags ──────────────────────────────────────────────────────────────────────
DRY_RUN=false
CONVERT_ONLY=false
AUDIT_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --convert)    CONVERT_ONLY=true ;;
    --audit)      AUDIT_ONLY=true ;;
    *)            echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Colors ─────────────────────────────────────────────────────────────────────
R='\033[0;31m'
G='\033[0;32m'
Y='\033[0;33m'
B='\033[0;34m'
C='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${B}[sync]${NC} $1"; }
ok()    { echo -e "${G}[sync]${NC} $1"; }
warn()  { echo -e "${Y}[sync]${NC} $1"; }
err()   { echo -e "${R}[sync]${NC} $1"; }
audit() { echo -e "${C}[audit]${NC} $1"; }

# ── Audit mode ─────────────────────────────────────────────────────────────────
run_audit() {
  info "Auditing remaining Linux-isms in src/ ..."
  echo ""

  local openclaw_env=$(grep -rn 'OPENCLAW_' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
  local dot_openclaw=$(grep -rn '\.openclaw' src/ --include='*.ts' 2>/dev/null | grep -v '\.freeclaw' | grep -v 'types\.openclaw' | wc -l | tr -d ' ')
  local openclaw_json=$(grep -rn '"openclaw\.json"' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
  local systemd_refs=$(grep -rn 'systemd\b' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | grep -v '// ' | grep -v 'rcd\|rc\.d\|FreeBSD' | wc -l | tr -d ' ')
  local launchd_refs=$(grep -rn 'launchd\b' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | grep -v '// ' | wc -l | tr -d ' ')
  local schtasks_refs=$(grep -rn 'schtasks' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local proc_refs=$(grep -rn '/proc/' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local lsof_refs=$(grep -rn '\blsof\b' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | grep -v 'ports-lsof' | wc -l | tr -d ' ')
  local platform_refs=$(grep -rn 'process\.platform' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local win32_refs=$(grep -rn '"win32"' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local darwin_refs=$(grep -rn '"darwin"' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local linux_refs=$(grep -rn '"linux"' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  local homebrew_refs=$(grep -rn 'homebrew\|Homebrew' src/ --include='*.ts' 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')

  audit "OPENCLAW_ env vars:           $openclaw_env"
  audit ".openclaw dir refs:           $dot_openclaw"
  audit "openclaw.json refs:           $openclaw_json"
  audit "systemd refs (non-test):      $systemd_refs"
  audit "launchd refs (non-test):      $launchd_refs"
  audit "schtasks refs (non-test):     $schtasks_refs"
  audit "/proc/ refs (non-test):       $proc_refs"
  audit "lsof refs (non-test):         $lsof_refs"
  audit "process.platform refs:        $platform_refs"
  audit "  win32 checks:               $win32_refs"
  audit "  darwin checks:              $darwin_refs"
  audit "  linux checks:               $linux_refs"
  audit "Homebrew refs:                $homebrew_refs"
  echo ""

  local total=$((openclaw_env + dot_openclaw + openclaw_json + systemd_refs + launchd_refs + schtasks_refs + proc_refs + lsof_refs))
  if [ "$total" -eq 0 ]; then
    ok "No critical Linux-isms found (env vars, dirs, init systems, /proc, lsof)."
  else
    warn "$total critical Linux-isms remain. Run: scripts/sync-upstream.sh --convert"
  fi

  if [ "$platform_refs" -gt 0 ]; then
    warn "$platform_refs process.platform refs remain (some are unavoidable for Node.js compat)."
    warn "Review with: grep -rn 'process.platform' src/ --include='*.ts' | grep -v '.test.'"
  fi
}

if $AUDIT_ONLY; then
  run_audit
  exit 0
fi

# ── Step 1: Merge upstream ─────────────────────────────────────────────────────
if ! $CONVERT_ONLY; then
  info "Fetching origin/main (upstream sync)..."
  git fetch origin main 2>&1 || { err "Failed to fetch origin/main"; exit 1; }

  CURRENT_BRANCH=$(git branch --show-current)
  info "Merging origin/main into $CURRENT_BRANCH ..."

  if $DRY_RUN; then
    # Show what would be merged
    MERGE_BASE=$(git merge-base HEAD origin/main)
    NEW_COMMITS=$(git log --oneline "$MERGE_BASE"..origin/main | wc -l | tr -d ' ')
    info "[dry-run] Would merge $NEW_COMMITS new commits from origin/main"
  else
    git merge origin/main --no-edit 2>&1 || {
      err "Merge conflicts detected. Resolve manually, then re-run with --convert"
      echo ""
      echo "Conflicted files:"
      git diff --name-only --diff-filter=U
      exit 1
    }
    ok "Merge complete."
  fi
fi

# ── Step 2: Run the FreeBSD conversion transforms ─────────────────────────────
info "Running FreeBSD conversion transforms..."

# The transform engine handles all replacements. It is a TypeScript file
# that operates on the source tree with precise, context-aware transforms.
# This avoids sed/awk foot-guns with regex edge cases.

if $DRY_RUN; then
  info "[dry-run] Would run: bun scripts/freebsd-convert.ts"
  info "[dry-run] Skipping actual transforms."
else
  if command -v bun &>/dev/null; then
    bun "$REPO_ROOT/scripts/freebsd-convert.ts" 2>&1
  elif command -v npx &>/dev/null; then
    npx tsx "$REPO_ROOT/scripts/freebsd-convert.ts" 2>&1
  else
    err "Need bun or npx (tsx) to run the conversion engine."
    exit 1
  fi
  ok "Conversion transforms applied."
fi

# ── Step 3: Audit ──────────────────────────────────────────────────────────────
echo ""
run_audit

# ── Step 4: Summary ────────────────────────────────────────────────────────────
echo ""
if $DRY_RUN; then
  info "[dry-run] No changes written."
else
  CHANGED=$(git diff --name-only | wc -l | tr -d ' ')
  if [ "$CHANGED" -eq 0 ]; then
    ok "No files changed — already converted."
  else
    ok "$CHANGED files updated by conversion."
    echo ""
    info "Review changes:"
    info "  git diff --stat"
    info ""
    info "Commit when ready:"
    info "  git add -A && git commit -m 'sync: merge upstream + FreeBSD conversion'"
  fi
fi
