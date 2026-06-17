// `lb serve` — launch the local web UI. Explicit, foreground (not a background
// daemon): each /api request re-runs the incremental index, so the page is fresh
// on pull. (docs/cost-plan.md → Phase 6, C4.)

import { startServer } from "../server.ts";
import { BIN_NAME } from "../constants.ts";
import type { Invocation } from "../parse.ts";

export async function runServe(inv: Invocation): Promise<void> {
  const port = typeof inv.flags.port === "number" ? inv.flags.port : 4178;
  startServer(port);
  const url = `http://localhost:${port}`;
  // Diagnostic line to stderr so stdout stays clean; the URL is the point.
  process.stderr.write(`${BIN_NAME}: serving at ${url}  (Ctrl-C to stop)\n`);
  // Block forever so the CLI process stays alive serving requests.
  await new Promise<void>(() => {});
}
