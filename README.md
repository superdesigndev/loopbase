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

Output is JSON by default (`--text` for humans). Session id is auto-resolved from

the environment — agents pass nothing.

## Install

loopbase runs on [Bun](https://bun.sh) ≥ 1.3 (it uses `bun:sqlite`).

```sh
bun add -g loopbase     # installs `loopbase` (+ `lb` alias) globally
bunx loopbase list      # or run without installing
```

Prefer a standalone binary (no runtime needed)? See [INSTALL.md](./INSTALL.md).

## Develop

```sh
bun install
bun run loopbase -- list          # run the CLI from source
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