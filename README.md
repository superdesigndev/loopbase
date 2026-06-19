# loopbase

Cross-session agent memory. Discover, read, and hand off work across local AI

agent sessions — Claude Code, Codex, and pi — on one machine.

> agent-facing usage in [SKILL.md](./SKILL.md).

## What it does

Every agent dumps its session transcript to disk. loopbase indexes all of them

(lazily, no daemon) and gives one CLI to:

- `**loopbase list**` — see the sessions in your project, across agents, each with its

  worklog as a table of contents.
- `**loopbase search "<text>"**` — find sessions/turns by content across agents; each

  hit carries a handle to jump straight to it.
- `**loopbase show <id>**` — understand a session: a structural **map** by default

  (worklog + turn outline), then drill into a turn, a worklog span, a tool

  result, or a subagent.
- `**loopbase log "<what I did>"**` — leave a worklog entry on your current session;

  it auto-spans the messages since your last log.
- `**loopbase cost**` — token + USD cost per session (also `--summary` by model,

  or `loopbase cost <id>` for one session's per-model breakdown).
- `**loopbase insights**` — ranked automation **candidates** mined from every

  session's tool calls: repeated/expensive patterns, recurring call sequences,
  and tools that keep failing. Ranked by **real attributed USD**, tagged with the
  dominant repo, and nested with sub-clusters (`composio run` → the Intercom
  tools it's really running). Each row links to `show --turn` examples.
- `**loopbase serve**` — a local web dashboard over everything above (see below).

Output is JSON by default (`--text` for humans). Session id is auto-resolved from

the environment — agents pass nothing.

## Web dashboard (`loopbase serve`)

```sh
loopbase serve              # → http://localhost:4178
loopbase serve --port 8080  # pick another port
```

A local, **read-only** dashboard over your indexed sessions — no account,
nothing leaves your machine, and it re-indexes on each load so it's always
fresh. What you get:

- **Sessions by cost** — every session with its token + USD spend; sortable,
  filterable by agent and time window, with resizable columns.
- **Group by working dir** — fold sessions under their project (git root),
  each with a cost subtotal; the git branch is shown per session.
- **Drill into a session** — per-model cost breakdown with a token-burn
  sparkline, **cost per log batch** (when you've logged more than once), the
  worklog, and a **paged conversation viewer** loaded on demand.
- **Insights tab** — automation candidates across all sessions: the most
  repeated/expensive tool patterns, recurring call sequences, and recurring
  errors, each with example sessions to open.

Cost is a **list-price estimate** computed from a built-in price catalog
(subscription billing differs). Refresh rates from upstream any time with
`loopbase cost --refresh`.

## Install

loopbase runs on [Bun](https://bun.sh) ≥ 1.3 (it uses `bun:sqlite`).

```sh
bun add -g @superdesign/loopbase   # installs `loopbase` (+ `lb` alias) globally
bunx @superdesign/loopbase list    # or run without installing
```

Prefer a standalone binary (no runtime needed)? See [INSTALL.md](./INSTALL.md).

## Develop

```sh
bun install
bun run loopbase -- list          # run the CLI from source
bun run serve:dev           # dashboard with hot reload (edits in src/web/ live-reload)
bun run check               # lint + typecheck + tests
bun run build               # compile a single binary → dist/loopbase
```

Requires [Bun](https://bun.sh) ≥ 1.3.

## Status

v0 (the JSONL family): Claude (read + write), Codex (read), pi (read). SQLite

(hermes) and openclaw adapters, hooks, LLM summaries, and team sync are planned 

## License

Mostly **AGPLv3**; files marked `/* @license Enterprise */` fall under the

loopbase Enterprise Commercial License. See [LICENSE](./LICENSE).