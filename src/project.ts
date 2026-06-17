// Resolve a cwd to its PROJECT key = git repo root if inside one, else the dir
// itself. (PLAN.md → Decision #4.) Cached per process.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const cache = new Map<string, string>();
const branchCache = new Map<string, string | null>();

export function resolveProject(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd)!;
  let dir = cwd;
  // Walk up looking for a .git entry (dir or file, for worktrees).
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      cache.set(cwd, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Not in a git repo → the directory itself is the project.
  cache.set(cwd, cwd);
  return cwd;
}

// Best-effort CURRENT git branch for a cwd, by reading .git/HEAD (no subprocess).
// Used as a fallback for agents that don't record branch in their transcript
// (e.g. pi). It reflects the branch *now*, not necessarily at session time.
export function currentGitBranch(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const root = resolveProject(cwd);
  if (!root) return null;
  if (branchCache.has(root)) return branchCache.get(root)!;
  let branch: string | null = null;
  try {
    const dotgit = join(root, ".git");
    let gitDir = dotgit;
    // Worktrees: .git is a file "gitdir: <path>".
    if (statSync(dotgit).isFile()) {
      const m = readFileSync(dotgit, "utf8").match(/gitdir:\s*(.+)/);
      if (m) gitDir = m[1]!.trim();
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) branch = ref[1]!; // detached HEAD (raw hash) → leave null
  } catch {
    branch = null;
  }
  branchCache.set(root, branch);
  return branch;
}
