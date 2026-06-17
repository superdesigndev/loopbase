# CLAUDE.md

Guidance for agents working in this repo. (Also an example of the loopbase rule
from `INSTALL.md` — the last line is the bit you'd copy into any project.)

## Project

loopbase — cross-session memory for AI coding agents. A daemonless CLI (`loopbase`, alias `lb`) that
indexes local agent session transcripts (Claude Code, Codex, pi) and exposes
`loopbase list` / `loopbase show` / `loopbase log`. TypeScript on Bun. Design + rationale in
`PLAN.md`; agent-facing usage in `SKILL.md`.

## Dev

```sh
bun run loopbase -- <cmd>     # run the CLI from source (e.g. bun run loopbase -- list)
bun run check          # naming-lint + typecheck + tests — run before committing
bun run build          # compile the standalone binary → dist/
```

- Index lives at `~/.loopbase/index.db` (override with `$LB_HOME`). It's derived
  and disposable except the `worklog` table; bump `SCHEMA_VERSION` on any schema
  *or* adapter-parsing change so it rebuilds.
- Output is JSON by default; errors go to stderr and should be self-healing
  (name the valid set + a working invocation).
- Don't commit to `main` directly — branch first.

## loopbase

loopbase: when you finish a batch of work — after a commit, or when the user moves to a new topic — log it, e.g. `loopbase log "fixed auth redirect loop" --tags auth --body "tokens refresh on 401; added retry + test"`.
