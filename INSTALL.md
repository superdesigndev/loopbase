# Install loopbase

> Onboarding for a repo or agent that doesn't have loopbase yet. Step 1 is once
>
> per machine; steps 2–4 are once per repo (or once globally).

## What loopbase is

Cross-session memory for AI coding agents. Every agent — Claude Code, Codex, pi —

writes its session transcript to disk; loopbase indexes them all and gives one CLI

so any agent can see and hand off work:

- `**loopbase list**` — sessions in this project (across agents), newest first, each with

  its worklog table-of-contents.
- `**loopbase search "<text>"**` — find sessions/turns by content across agents; each hit

  carries a handle to jump straight to it.
- `**loopbase show <id>**` — understand a session: a map of its turns by default; drill in

  with `--turn N` / `--log <id>` / `--role all`.
- `**loopbase log "<what I did>"**` — leave a worklog entry on *your* session so the next

  agent or teammate can catch up.

Local-first (index at `~/.loopbase/index.db`), no daemon, JSON output by default.

It only **reads** other agents' files; nothing to configure per agent.

## 1. Install the `loopbase` CLI  (once per machine)

Requires [Bun](https://bun.sh) ≥ 1.3 (loopbase uses `bun:sqlite`).

```sh
bun add -g @superdesign/loopbase   # installs `loopbase` (+ `lb` alias) globally
loopbase --help
loopbase list                      # lists this repo's sessions across agents
```

Or run it without installing: `bunx @superdesign/loopbase list`.

**From source / standalone binary** (no Bun needed at runtime):

```sh
git clone https://github.com/superdesigndev/loopbase ~/loopbase && cd ~/loopbase
bun install
bun run build              # → dist/loopbase (standalone, embeds the runtime)
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/loopbase" ~/.local/bin/loopbase
ln -sf "$PWD/dist/loopbase" ~/.local/bin/lb     # short alias
# ensure ~/.local/bin is on PATH
```

Dev (live-reload from source): `bun link` in the repo registers `loopbase` + `lb` globally.

## 2. Install the skill  (so the agent knows loopbase exists)

**Claude Code** — drop `SKILL.md` into a skills dir, project-scoped or global
(works whichever way you installed — it pulls the skill straight from the repo):

```sh
# project-scoped (this repo):
mkdir -p .claude/skills/loopbase
curl -fsSL https://raw.githubusercontent.com/superdesigndev/loopbase/main/SKILL.md \
  -o .claude/skills/loopbase/SKILL.md
# or global (all repos): same, into ~/.claude/skills/loopbase/SKILL.md
```

(Installed from source? Just `cp ~/loopbase/SKILL.md` instead of the curl.)

**Other agents (Codex, pi, …)** — copy `SKILL.md` wherever that agent loads skills,

or paste its essentials into the agent's instruction file (e.g. `AGENTS.md` for

Codex). The CLI behaves the same; only discovery differs.

## 3. Add the logging rule to your agent instructions  (CLAUDE.md / AGENTS.md)

Add one line to `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex):

```md
## Log the progress
After you finish a batch of work (e.g. after a commit, or when the user moves to a new topic), MUST log it via loopbase cli - e.g. `loopbase log "fixed auth redirect" --tags auth --body "tokens refresh on 401; added retry + test"`. those will be used as global log memory across session to enrich context
```

(The skill from step 2 has the full usage; this line is just the trigger + example.)

## Verify

```sh
loopbase list                            # sessions for the current project
loopbase log "set up loopbase" --tags infra --body "installed cli + skill + CLAUDE.md rule"
loopbase show <id>                       # the entry appears under your session's worklog
```

That's it — the CLI is machine-wide; the skill + CLAUDE.md rule are what make an

agent actually *use* it in a given repo.