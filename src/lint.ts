#!/usr/bin/env bun
// CI naming-lint: fails if the command spec drifts from the vocabulary rules
// (banned verbs/flags, enums without values). (PLAN.md → Principle 6.)
import { lintSpec } from "./spec.ts";

const errors = lintSpec();
if (errors.length) {
  console.error("naming-lint FAILED:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("naming-lint OK");
