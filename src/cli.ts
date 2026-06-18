#!/usr/bin/env bun
// loopbase CLI entry. Parses argv via the spec, dispatches to a handler, and
// owns process exit + error rendering. (PLAN.md → CLI Design.)

import { parse } from "./parse.ts";
import { topHelp, commandHelp } from "./help.ts";
import { emit, emitError, EXIT, type OutputMode, CliError } from "./output.ts";
import type { Invocation } from "./parse.ts";
import { reindex } from "./indexer.ts";
import { runList } from "./commands/list.ts";
import { runShow } from "./commands/show.ts";
import { runLog } from "./commands/log.ts";
import { runSearch } from "./commands/search.ts";
import { runCost } from "./commands/cost.ts";
import { runInsights } from "./commands/insights.ts";
import { runServe } from "./commands/serve.ts";

type Handler = (inv: Invocation) => Promise<void> | void;

const handlers: Record<string, Handler> = {
  log: (inv) => runLog(inv),
  list: (inv) => runList(inv),
  show: (inv) => runShow(inv),
  search: (inv) => runSearch(inv),
  cost: (inv) => runCost(inv),
  insights: (inv) => runInsights(inv),
  serve: (inv) => runServe(inv),
  index: (inv) => {
    const stats = reindex({ rebuild: inv.flags.rebuild === true });
    emit({ ok: true, ...stats }, inv.mode);
  },
};

// Pre-detect output mode from raw argv so even parse-time errors render in the
// requested format. JSON default; --text flips off; --json forces on.
function detectMode(argv: string[]): OutputMode {
  if (argv.includes("--text")) return { json: false };
  return { json: true };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Help is a diagnostic-ish surface but goes to stdout (it's the requested output).
  let mode: OutputMode = detectMode(argv);
  try {
    const result = parse(argv);
    if (result.kind === "help-top") {
      process.stdout.write(topHelp() + "\n");
      return EXIT.OK;
    }
    if (result.kind === "help-command") {
      process.stdout.write(commandHelp(result.command!) + "\n");
      return EXIT.OK;
    }
    const inv = result.invocation!;
    mode = inv.mode;
    const handler = handlers[inv.command.name];
    if (!handler) throw new CliError(EXIT.USAGE, { error: "usage", message: `no handler for ${inv.command.name}` });
    await handler(inv);
    return EXIT.OK;
  } catch (err) {
    return emitError(err, mode);
  }
}

main().then((code) => process.exit(code));
