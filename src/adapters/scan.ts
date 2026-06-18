// Resilient transcript enumeration.
//
// Several adapters scan a homedir root (`~/.claude/projects`, `~/.pi/agent/sessions`)
// whose top level is one directory per project. Bun's `Glob.scanSync` is a LAZY
// iterator: when it descends into a directory the user can't read (e.g. a
// root-owned `drwx------ ~/.claude/projects/-Users-…-dotnix`), it THROWS EACCES
// mid-iteration instead of skipping. That throw propagates out of enumerate(),
// the indexer's safeEnumerate() catches it and returns [], and EVERY session for
// that adapter silently vanishes from the index.
//
// Fix: drive the walk ourselves — list the project dirs, then run the glob scoped
// to each one inside a try/catch, skipping the dirs that throw a permission
// error. One bad dir no longer aborts the whole scan.

import { readdirSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";
import { Glob } from "bun";

// Default per-dir scan used in production: glob `pattern` scoped to one project
// dir. Injectable in `scanProjectDirs` so tests can drive the walk without Bun /
// the real FS (they pass their own `scanDir`).
export function bunGlobScan(dir: string, pattern: string): Iterable<string> {
  return new Glob(pattern).scanSync(dir);
}

// FS errors we treat as "skip this directory" rather than fatal. A root-owned
// project dir gives EACCES/EPERM.
const SKIP_CODES = new Set(["EACCES", "EPERM"]);

function isSkippable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && SKIP_CODES.has(code);
}

// List immediate subdirectory names of `root`, skipping non-dir entries. Returns
// [] if the root itself is unreadable (caller already guards existence).
export function listProjectDirs(
  root: string,
  readdir: typeof readdirSync = readdirSync,
): string[] {
  try {
    return readdir(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if (isSkippable(err)) return [];
    throw err;
  }
}

// Scan `root` with `glob`, but one project directory at a time so a single
// unreadable directory only drops that directory, not the entire scan. The glob
// pattern is given RELATIVE TO A PROJECT DIR (it must not include the top-level
// `*/` segment), and yields paths relative to `root` (project name re-prefixed),
// matching the shape `new Glob(pattern).scanSync(root)` produced before.
//
// `scanDir(dir, pattern)` runs the per-dir scan (injectable for tests); it must
// throw the underlying FS error so we can decide whether to skip.
export function scanProjectDirs(
  root: string,
  perDirPattern: string,
  scanDir: (dir: string, pattern: string) => Iterable<string> = bunGlobScan,
  readdir: typeof readdirSync = readdirSync,
): string[] {
  const out: string[] = [];
  for (const project of listProjectDirs(root, readdir)) {
    const dir = join(root, project);
    try {
      for (const rel of scanDir(dir, perDirPattern)) {
        out.push(posix.join(project, rel));
      }
    } catch (err) {
      if (isSkippable(err)) continue; // skip this project dir, keep going
      throw err;
    }
  }
  return out;
}

// Recursively walk `root`, collecting files whose basename satisfies `match`,
// skipping any directory we can't read (same EACCES/EPERM rule as above). For
// adapters whose tree ISN'T a flat list of project dirs — e.g. codex's
// `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — so one unreadable directory
// drops only that directory, not the whole scan (the same silent-total-loss
// failure `scanProjectDirs` fixes for the flat layout). Yields paths relative to
// `root` with posix `/` separators. `readdir` is injectable for tests.
export function walkFilesResilient(
  root: string,
  match: (name: string) => boolean,
  readdir: typeof readdirSync = readdirSync,
): string[] {
  const out: string[] = [];
  const stack: string[] = [""]; // dirs relative to root; "" == root itself
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(root, relDir) : root;
    let entries: Dirent[];
    try {
      entries = readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isSkippable(err)) continue; // unreadable dir → skip, keep walking
      throw err;
    }
    for (const e of entries) {
      const rel = relDir ? posix.join(relDir, e.name) : e.name;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile() && match(e.name)) out.push(rel);
    }
  }
  return out;
}
