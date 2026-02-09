/**
 * Native kqueue-backed file watching for FreeBSD.
 *
 * On FreeBSD, Node.js `fs.watch` already uses kqueue(2) under the hood.  This
 * module wraps `fs.watch` with proper configuration for production use:
 *
 * - Correct handling of `rename` events (kqueue reports renames as a delete
 *   followed by a create on a different vnode, unlike inotify).
 * - Debouncing of rapid event bursts.
 * - Recursive directory watching with efficient re-scan on directory creation.
 * - Ignore patterns for `.git`, `node_modules`, and other noise.
 * - Extension filtering.
 * - A disposable watcher that cleans up all handles on close.
 *
 * This is designed as a lightweight, drop-in replacement for chokidar that
 * avoids the overhead of polling and extra dependencies on FreeBSD.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a kqueue watcher. */
export type KqueueWatcherOptions = {
  /** Debounce interval in milliseconds.  Default: 100. */
  debounceMs?: number;

  /**
   * Glob-style ignore patterns.  Any path component matching one of these
   * patterns (exact or minimatch-style leading dot) is ignored.
   *
   * Default: `[".git", "node_modules", ".DS_Store"]`
   */
  ignorePatterns?: string[];

  /**
   * If set, only report changes to files whose extension (without the leading
   * dot) is in this list.  An empty array means "all extensions".
   *
   * Example: `["ts", "js", "json", "yaml", "yml"]`
   */
  extensions?: string[];

  /** If true, watch directories recursively.  Default: true. */
  recursive?: boolean;
};

/** The type of change detected. */
export type WatchEventType = "change" | "rename" | "create" | "delete";

/** A single file-change event delivered to the callback. */
export type WatchEvent = {
  type: WatchEventType;
  /** Absolute path to the changed file or directory. */
  path: string;
};

/** Callback invoked when one or more file changes are detected. */
export type WatchCallback = (events: WatchEvent[]) => void;

/** A disposable watcher handle. */
export type KqueueWatcher = {
  /** Stop watching and release all resources. */
  close(): void;
  /** Whether the watcher is still active. */
  readonly active: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 100;

const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ".git",
  "node_modules",
  ".DS_Store",
  ".swp",
  ".swo",
  "__pycache__",
  ".nyc_output",
  "coverage",
];

const log: SubsystemLogger = createSubsystemLogger("freebsd/kqueue");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldIgnore(filePath: string, ignorePatterns: readonly string[]): boolean {
  const segments = filePath.split(path.sep);
  for (const segment of segments) {
    for (const pattern of ignorePatterns) {
      if (segment === pattern) {
        return true;
      }
      // Also match patterns that start with a dot (e.g. ".cache" matches any
      // directory named ".cache").
      if (pattern.startsWith(".") && segment === pattern) {
        return true;
      }
    }
  }
  return false;
}

function matchesExtension(filePath: string, extensions: readonly string[]): boolean {
  if (extensions.length === 0) {
    return true;
  }
  const ext = path.extname(filePath);
  if (!ext) {
    return false;
  }
  // Remove the leading dot.
  const bare = ext.slice(1).toLowerCase();
  return extensions.includes(bare);
}

/**
 * Collect all directories under `root` (including `root` itself), respecting
 * ignore patterns.
 */
function collectDirectories(root: string, ignorePatterns: readonly string[]): string[] {
  const dirs: string[] = [];

  function walk(dir: string): void {
    if (shouldIgnore(dir, ignorePatterns)) {
      return;
    }
    dirs.push(dir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permission denied or deleted between readdir and stat — skip.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const childPath = path.join(dir, entry.name);
      if (shouldIgnore(entry.name, ignorePatterns)) {
        continue;
      }
      walk(childPath);
    }
  }

  walk(root);
  return dirs;
}

// ---------------------------------------------------------------------------
// Core: single-path watcher
// ---------------------------------------------------------------------------

/**
 * Create a kqueue-backed watcher for one or more file or directory paths.
 *
 * Uses `fs.watch` which delegates to kqueue on FreeBSD.  Events are debounced
 * and filtered before being delivered to `callback`.
 *
 * @returns A disposable `KqueueWatcher`.
 */
export function createKqueueWatcher(
  paths: string | string[],
  callback: WatchCallback,
  options: KqueueWatcherOptions = {},
): KqueueWatcher {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    ignorePatterns = [...DEFAULT_IGNORE_PATTERNS],
    extensions = [],
    recursive = false,
  } = options;

  const resolvedPaths = (Array.isArray(paths) ? paths : [paths]).map((p) => path.resolve(p));

  const watchers: fs.FSWatcher[] = [];
  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvents = new Map<string, WatchEventType>();

  function flush(): void {
    if (pendingEvents.size === 0) {
      return;
    }
    const batch = pendingEvents;
    pendingEvents = new Map();
    const events: WatchEvent[] = [];
    for (const [filePath, eventType] of batch) {
      events.push({ type: eventType, path: filePath });
    }
    try {
      callback(events);
    } catch (err) {
      log.error(`Watcher callback error: ${String(err)}`);
    }
  }

  function scheduleFlush(): void {
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush();
    }, debounceMs);
  }

  function handleEvent(eventType: string, filename: string | null, watchedPath: string): void {
    if (!active) {
      return;
    }

    // `filename` may be null on some platforms; on FreeBSD/kqueue it is
    // typically populated for files within a watched directory.
    const fullPath = filename ? path.resolve(watchedPath, filename) : watchedPath;

    // Apply ignore filters.
    if (shouldIgnore(fullPath, ignorePatterns)) {
      return;
    }

    // Apply extension filter.
    if (extensions.length > 0 && !matchesExtension(fullPath, extensions)) {
      // Could be a directory event — check if it exists and is a dir.
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
          return;
        }
      } catch {
        // File may have been deleted; let it through as a delete.
      }
    }

    // Normalise the fs.watch event type to our WatchEventType.
    // kqueue on FreeBSD reports:
    //   - "rename" for both creates and deletes (vnode NOTE_RENAME,
    //     NOTE_DELETE, NOTE_REVOKE).
    //   - "change" for content modifications (NOTE_WRITE, NOTE_EXTEND,
    //     NOTE_ATTRIB).
    let type: WatchEventType;
    if (eventType === "rename") {
      // Disambiguate: does the file still exist?
      try {
        fs.accessSync(fullPath, fs.constants.F_OK);
        type = "create";
      } catch {
        type = "delete";
      }
    } else {
      type = "change";
    }

    pendingEvents.set(fullPath, type);
    scheduleFlush();
  }

  // Set up watchers.
  for (const watchPath of resolvedPaths) {
    try {
      const watcher = fs.watch(
        watchPath,
        {
          persistent: true,
          recursive,
        },
        (eventType, filename) => {
          handleEvent(eventType, filename as string | null, watchPath);
        },
      );

      watcher.on("error", (err) => {
        log.warn(`fs.watch error on ${watchPath}: ${String(err)}`);
        // Attempt to recover by removing this watcher; the directory may
        // have been deleted.
      });

      watchers.push(watcher);
    } catch (err) {
      log.warn(`Failed to watch ${watchPath}: ${String(err)}`);
    }
  }

  return {
    close() {
      if (!active) {
        return;
      }
      active = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Flush any remaining events.
      flush();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Already closed or errored.
        }
      }
      watchers.length = 0;
    },
    get active() {
      return active;
    },
  };
}

// ---------------------------------------------------------------------------
// High-level: recursive directory tree watcher
// ---------------------------------------------------------------------------

/**
 * Recursively watch a directory tree for changes.
 *
 * On FreeBSD, `fs.watch` with `recursive: true` may not be supported on all
 * filesystem types.  This function manually enumerates subdirectories and
 * sets up individual watchers, then monitors for new directory creation to
 * extend coverage dynamically.
 *
 * @returns A disposable `KqueueWatcher`.
 */
export function watchDirectoryTree(
  dir: string,
  callback: WatchCallback,
  options: KqueueWatcherOptions = {},
): KqueueWatcher {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    ignorePatterns = [...DEFAULT_IGNORE_PATTERNS],
    extensions = [],
  } = options;

  const resolvedDir = path.resolve(dir);
  let active = true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvents = new Map<string, WatchEventType>();

  // Track active per-directory watchers so we can close them and add new ones.
  const dirWatchers = new Map<string, fs.FSWatcher>();

  function flush(): void {
    if (pendingEvents.size === 0) {
      return;
    }
    const batch = pendingEvents;
    pendingEvents = new Map();
    const events: WatchEvent[] = [];
    for (const [filePath, eventType] of batch) {
      events.push({ type: eventType, path: filePath });
    }
    try {
      callback(events);
    } catch (err) {
      log.error(`Directory tree watcher callback error: ${String(err)}`);
    }
  }

  function scheduleFlush(): void {
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush();
    }, debounceMs);
  }

  function handleDirEvent(watchedDir: string, eventType: string, filename: string | null): void {
    if (!active) {
      return;
    }

    const fullPath = filename ? path.join(watchedDir, filename) : watchedDir;

    if (shouldIgnore(fullPath, ignorePatterns)) {
      return;
    }

    // Determine event type.
    let type: WatchEventType;
    let isDir = false;
    if (eventType === "rename") {
      try {
        const stat = fs.statSync(fullPath);
        isDir = stat.isDirectory();
        type = "create";
      } catch {
        type = "delete";
      }
    } else {
      type = "change";
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch {
        isDir = false;
      }
    }

    // If a new directory was created, start watching it (and its subtree).
    if (type === "create" && isDir) {
      const newDirs = collectDirectories(fullPath, ignorePatterns);
      for (const newDir of newDirs) {
        if (!dirWatchers.has(newDir)) {
          watchSingleDir(newDir);
        }
      }
    }

    // If a directory was deleted, clean up its watcher.
    if (type === "delete" && dirWatchers.has(fullPath)) {
      const w = dirWatchers.get(fullPath);
      dirWatchers.delete(fullPath);
      try {
        w?.close();
      } catch {
        // Already closed.
      }
    }

    // Apply extension filter (only for files, not directories).
    if (!isDir && extensions.length > 0 && !matchesExtension(fullPath, extensions)) {
      return;
    }

    pendingEvents.set(fullPath, type);
    scheduleFlush();
  }

  function watchSingleDir(dirPath: string): void {
    if (!active) {
      return;
    }
    if (dirWatchers.has(dirPath)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, { persistent: true }, (evtType, filename) => {
        handleDirEvent(dirPath, evtType, filename as string | null);
      });

      watcher.on("error", (err) => {
        // Directory may have been deleted. Remove the watcher.
        log.debug(`fs.watch error on ${dirPath}: ${String(err)}`);
        dirWatchers.delete(dirPath);
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      });

      dirWatchers.set(dirPath, watcher);
    } catch (err) {
      log.debug(`Failed to watch directory ${dirPath}: ${String(err)}`);
    }
  }

  // Initial scan: enumerate all directories.
  const allDirs = collectDirectories(resolvedDir, ignorePatterns);
  for (const d of allDirs) {
    watchSingleDir(d);
  }

  log.debug(`Watching directory tree ${resolvedDir} (${allDirs.length} directories)`);

  return {
    close() {
      if (!active) {
        return;
      }
      active = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      flush();
      for (const [, watcher] of dirWatchers) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      }
      dirWatchers.clear();
    },
    get active() {
      return active;
    },
  };
}
