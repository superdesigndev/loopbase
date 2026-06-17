---
name: loopbase
description: >
  Discover, read, and hand off work across local AI agent sessions (Claude Code,
  Codex, pi — same machine). Use when you need to know what other agents/sessions
  have done in this project, pick up another session's work, or record what you
  just did so the next agent can continue. Triggers: "what else was done here",
  "what did the other session do", "hand off", "where did we leave off",
  "log this", cross-session/cross-agent context.
---

# loopbase — cross-session agent memory

`loopbase` reads every local agent session's transcript (Claude/Codex/pi) and lets you
leave a running worklog. Output is **JSON by default** (pass `--text` for humans).
It indexes lazily on each call — no daemon, nothing to start.

## The commands

```
loopbase list                 # sessions in THIS project, each with its worklog (a TOC)
loopbase search "<text>"       # find sessions/turns by content (across agents) → a `turn` handle
loopbase show <session_id>     # read/understand one session (map by default, then drill)
loopbase log  "<what I did>"   # append a worklog entry to YOUR current session
```

## Workflows

### 1. "What else has happened in this project?"
```
loopbase list                         # current project (cwd → git root), most-recent first
loopbase list --all                   # every project
loopbase list --since 24h --agent codex
loopbase list --logs                  # flat worklog feed (LOG.md-style) across sessions, newest first
loopbase list --logs --all --since 7d # everything logged anywhere this week → then dive: `loopbase show <session> --log <id>`
```
Each session shows: `id`, `agent`, `branch`, `title`, `updated`, `msgs`,
`subagents` count, and nested `worklog` entries. The `id` is the handle for `show`.

### 1b. "Where did anyone look into X?" (search by content)
```
loopbase search "JWT refresh"         # this project, across agents; each hit carries a `turn` handle
loopbase search "Necmttn/ax" --all    # every project — find any session that discussed it
loopbase search "<pattern>" --regex --since 7d --agent codex
loopbase search "foo" --files         # grep -l style: matching sessions + raw paths, for your own piping
```
A match gives `{ session, turn|subagent, snippet, path }` — dive with the same
ladder: `loopbase show <session> --turn <n>` (or `--agent <id>` for a subagent hit).
Search is the content-addressed entry; the map is the structural one.

### 2. "Pick up another session's work" (the handover)

`loopbase show <id>` defaults to **the map** — never the raw transcript.
Read the map to understand; open only what you need:
```
loopbase show 9a6282d1                 # THE MAP: worklog groups (or a flat turn outline) + unlogged tail.
                                 #   each turn has a `turn` handle + `then:{replies,tool_calls}` heatmap. No bodies.
loopbase show 9a6282d1 --turn 39       # open ONE user turn (the `turn` handle) → its messages
loopbase show 9a6282d1 --log lg_4f2a   # open one worklog span's messages
loopbase show 9a6282d1 --role all      # the FULL transcript (paged); --role assistant = assistant only
loopbase show 9a6282d1 --tool tu_9c    # full untruncated result of ONE tool call
loopbase show 9a6282d1 --agent adaf5e2 # descend into a subagent's transcript
loopbase show 9a6282d1 --turn 39 --expand-tools   # inline tool I/O within a turn
```
Branch on which key is present: `worklog`/`turns` = the map, `messages` = a
transcript view, `tool` = one tool result. Paged views carry a compact
`more:{shown,total,next_offset}` when there's more. `--max-chars` bounds text;
`--deliver file:PATH` writes to a file.

### Long sessions (the map is the answer)

You never dump a long transcript. `show` defaults to the bounded map, and every
messages view is paged (`--limit`/`--offset`, with a `shown` field + hint):

1. `loopbase show <id>` — the map. If `logged`, worklog entries are the curated
   sections; else it's the turn outline. `then` counts show which turns are heavy
   *before* you open them; `unlogged` = work not yet worklogged.
2. `loopbase show <id> --turn <n>` — open just that turn (bounded/paged).
3. `--role all` only when you truly need the whole transcript (still paged).

### 3. "Record what I just did"
```
loopbase log "finished auth refactor: moved sessions to JWT" --tags infra,product \
       --body "dropped the sessions table; verify is now stateless; 12 tests pass"
```
- `text` = a one-line **title**; `--tags a,b` = tags; `--body` = optional 1–2 line
  detail (outcome first). (Like a LOG.md entry: title · #tags · What.)
- Session id is auto-resolved from the environment — pass nothing.
- A `log` **auto-spans the messages since your last log** — so the worklog
  becomes a table-of-contents of the session (shown in `loopbase list` / `loopbase show`,
  replayable with `loopbase show --log <id>`). `--dry-run` previews the span.

**Log ONE entry per batch of work, right after you finish it.** Don't fire
several `log`s back-to-back to "catch up" — a normal `log` only covers what
happened since the previous one, so a second immediate log covers nothing and is
**rejected** ("no new messages since your last log"). So: do a batch → `log` it →
do the next → `log` it. One good line beats five empty ones.

#### Advanced: retro-tag a past turn range (`--turns`)
To backfill the worklog *after the fact* — label specific earlier turns rather
than auto-spanning forward — **inspect first, then tag**:
```
loopbase show <id>                              # read the map, note the turn range you mean
loopbase log "investigated the ax repo" --turns 6-14 --tags research
loopbase log "fixed the redirect" --turns 20    # a single turn
```
This is reliable *only because you read the turn numbers from `show` first* —
don't guess turn numbers from memory. A `--turns` entry is anchored to that exact
range and does **not** move the forward cursor (so normal `log` keeps working).
Out-of-range turns are rejected with the valid count. Use it to retro-generate a
worklog for an un-logged session, or to tag a sub-range more precisely.

## Tips
- IDs shown are short prefixes; `show` accepts any unambiguous prefix.
- Errors are structured (`{error, ...}`) with a stable exit-code taxonomy
  (2 usage · 3 not-found · 4 invalid-value · 5 empty · 6 io).
- Log at task boundaries (after shipping a fix, finishing an investigation), not
  every message — that keeps the worklog a useful map.
