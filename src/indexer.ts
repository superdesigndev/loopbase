// Incremental indexer. Daemonless: runs inside the CLI on each call. Enumerates
// each adapter's transcript files, skips unchanged ones by mtime, re-parses the
// rest, and upserts session/subagent rows. (PLAN.md → Incremental indexer.)

import { openDb, resetDb } from "./db.ts";
import { ADAPTERS } from "./adapters/registry.ts";
import { resolveProject, currentGitBranch } from "./project.ts";
import type { SourceFile } from "./adapters/types.ts";
import { loadCatalog } from "./pricing.ts";
import { makeCostWriter } from "./cost-index.ts";
import { makeInsightsWriter } from "./insights-index.ts";

export interface IndexStats {
  scanned: number;
  updated: number;
  skipped: number;
}

export function reindex(opts: { rebuild?: boolean } = {}): IndexStats {
  const db = openDb();
  if (opts.rebuild) resetDb();

  // Skip checks are keyed by PATH so we can skip BEFORE parsing (the native id
  // would otherwise require parsing the file first — the slow path).
  const sessionByPath = db.prepare("SELECT last_mtime FROM sessions WHERE path = ?");
  const threadByPath = db.prepare("SELECT last_mtime FROM agent_threads WHERE path = ?");

  const upsertSession = db.prepare(`
    INSERT INTO sessions
      (native_id, agent, project, cwd, branch, path, started_at, last_ts, msg_count, title, last_offset, last_mtime)
    VALUES ($id, $agent, $project, $cwd, $branch, $path, $started, $last, $count, $title, $offset, $mtime)
    ON CONFLICT(native_id) DO UPDATE SET
      project=$project, cwd=$cwd, branch=$branch, path=$path, started_at=$started,
      last_ts=$last, msg_count=$count, title=$title, last_offset=$offset, last_mtime=$mtime
  `);
  const upsertThread = db.prepare(`
    INSERT INTO agent_threads
      (agent_id, parent_native_id, agent_type, description, tool_use_id, path, msg_count, last_offset, last_mtime)
    VALUES ($id, $parent, $type, $desc, $tuid, $path, $count, $offset, $mtime)
    ON CONFLICT(agent_id) DO UPDATE SET
      parent_native_id=$parent, agent_type=$type, description=$desc, tool_use_id=$tuid,
      path=$path, msg_count=$count, last_offset=$offset, last_mtime=$mtime
  `);

  // Cost layer: load the price catalog once, memoize cost per session as we go.
  const { catalog, version } = loadCatalog();
  const costWriter = makeCostWriter(db, catalog, version);
  // Insights layer: extract tool-call facts from the same parsed events.
  const insightsWriter = makeInsightsWriter(db);
  // Subagent (Task + nested workflow) token usage rolls into the PARENT
  // session's cost — ccusage counts these sidecar files. Adapters expose all of
  // them via subagentFilesFor(); track parents whose cost needs a rewrite
  // because a subagent changed even when the main file didn't.
  const costDirty = new Set<string>();
  const sessionMetaForCost = db.prepare("SELECT path, agent FROM sessions WHERE native_id = ?");
  const subFilesFor = (adapter: (typeof ADAPTERS)[number], mainPath: string): string[] => {
    try {
      return adapter.subagentFilesFor?.(mainPath) ?? [];
    } catch {
      return [];
    }
  };

  const stats: IndexStats = { scanned: 0, updated: 0, skipped: 0 };

  const tx = db.transaction((files: { adapterIdx: number; file: SourceFile }[]) => {
    for (const { adapterIdx, file } of files) {
      stats.scanned++;
      const adapter = ADAPTERS[adapterIdx]!;

      if (file.kind === "subagent") {
        const prev = threadByPath.get(file.path) as { last_mtime: number } | null;
        if (prev && prev.last_mtime === file.mtimeMs) {
          stats.skipped++;
          continue; // skip BEFORE parsing
        }
        // A subagent changed → its parent's cost must be (re)written.
        if (file.parentNativeId) costDirty.add(file.parentNativeId);
        const events = safeRead(adapter, file.path);
        const size = fileSize(file.path);
        const meta = file.loadMeta?.() ?? {}; // deferred read happens only here
        upsertThread.run({
          $id: file.agentId!,
          $parent: file.parentNativeId ?? "",
          $type: meta.agentType ?? null,
          $desc: meta.description ?? null,
          $tuid: meta.toolUseId ?? null,
          $path: file.path,
          $count: events.filter((e) => e.role === "user" || e.role === "assistant").length,
          $offset: size,
          $mtime: file.mtimeMs,
        });
        stats.updated++;
        continue;
      }

      // Main session — skip by path+mtime BEFORE the expensive parse.
      const prev = sessionByPath.get(file.path) as { last_mtime: number } | null;
      if (prev && prev.last_mtime === file.mtimeMs) {
        stats.skipped++;
        continue;
      }
      const events = safeRead(adapter, file.path);
      const meta = adapter.deriveMeta(file.path, events);
      // Guard: skip empty / unparseable transcripts with no messages and no id signal.
      if (meta.msgCount === 0 && !meta.title) {
        stats.skipped++;
        continue;
      }
      upsertSession.run({
        $id: meta.nativeId,
        $agent: adapter.kind,
        $project: resolveProject(meta.cwd),
        $cwd: meta.cwd,
        // Use the branch the agent recorded (accurate, session-time); fall back
        // to the repo's current branch for agents that don't record it (pi).
        $branch: meta.branch ?? currentGitBranch(meta.cwd),
        $path: file.path,
        $started: meta.startedAt,
        $last: meta.lastTs,
        $count: meta.msgCount,
        $title: meta.title,
        $offset: fileSize(file.path),
        $mtime: file.mtimeMs,
      });
      // Memoize token + cost for this (changed) session — main file + any
      // subagent sidecars roll into one session cost. Never let a cost
      // extraction fault break indexing of the session itself.
      try {
        const subs = subFilesFor(adapter, file.path);
        costWriter.writeForSession(adapter, meta.nativeId, [file.path, ...subs], fileSize(file.path));
        costDirty.delete(meta.nativeId); // handled here, don't re-do below
      } catch {
        // skip cost for this session; transcript indexing already succeeded
      }
      // Extract tool-call facts from the events we already parsed. Never let an
      // insights fault break indexing of the session itself.
      try {
        insightsWriter.writeForSession(meta.nativeId, events);
      } catch {
        // skip insights facts for this session; transcript indexing succeeded
      }
      stats.updated++;
    }

    // Parents whose subagent changed but whose MAIN file was unchanged (skipped
    // above) still need a cost rewrite so subagent spend is counted.
    for (const parent of costDirty) {
      const meta = sessionMetaForCost.get(parent) as { path: string; agent: string } | null;
      if (!meta) continue;
      const adapter = ADAPTERS.find((a) => a.kind === meta.agent);
      if (!adapter) continue;
      try {
        const subs = subFilesFor(adapter, meta.path);
        costWriter.writeForSession(adapter, parent, [meta.path, ...subs], fileSize(meta.path));
      } catch {
        // leave prior cost in place
      }
    }
  });

  const queue: { adapterIdx: number; file: SourceFile }[] = [];
  ADAPTERS.forEach((adapter, adapterIdx) => {
    for (const file of safeEnumerate(adapter)) queue.push({ adapterIdx, file });
  });
  tx(queue);

  return stats;
}

function safeEnumerate(adapter: (typeof ADAPTERS)[number]): SourceFile[] {
  try {
    return adapter.enumerate();
  } catch {
    return [];
  }
}

function safeRead(adapter: (typeof ADAPTERS)[number], path: string) {
  try {
    return adapter.readEvents(path);
  } catch {
    return [];
  }
}

function fileSize(path: string): number {
  try {
    return Bun.file(path).size;
  } catch {
    return 0;
  }
}
