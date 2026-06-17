// Help text generated from the spec (Layer-1 introspection). Reads PRODUCT/BIN
// from constants so a rename needs no edits here.

import { BIN_NAME } from "./constants.ts";
import { COMMANDS, GLOBAL_FLAGS, type CommandSpec } from "./spec.ts";

function flagLine(f: { name: string; type: string; enumValues?: string[]; default?: unknown; desc: string }): string {
  const val =
    f.type === "bool" ? "" : f.type === "enum" ? ` <${f.enumValues!.join("|")}>` : f.type === "int" ? " <n>" : " <s>";
  const def = f.default !== undefined && f.type !== "bool" ? ` (default: ${f.default})` : "";
  return `    --${f.name}${val}`.padEnd(28) + ` ${f.desc}${def}`;
}

export function topHelp(): string {
  const lines: string[] = [];
  lines.push(`${BIN_NAME}  Cross-session agent memory.`);
  lines.push("");
  lines.push(`USAGE: ${BIN_NAME} <command> [flags]`);
  lines.push("");
  lines.push("COMMANDS:");
  for (const c of COMMANDS.filter((c) => !c.hidden)) {
    lines.push(`  ${c.name.padEnd(8)} ${c.summary}`);
  }
  lines.push("");
  lines.push(`Run \`${BIN_NAME} <command> --help\` for command details.`);
  lines.push("Output is JSON by default; pass --text for human-readable output.");
  return lines.join("\n");
}

export function commandHelp(cmd: CommandSpec): string {
  const lines: string[] = [];
  const argStr = cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  lines.push(`${BIN_NAME} ${cmd.name} ${argStr}`.trimEnd());
  lines.push("");
  lines.push(cmd.summary);
  if (cmd.args.length) {
    lines.push("");
    lines.push("ARGUMENTS:");
    for (const a of cmd.args) lines.push(`  ${a.name.padEnd(14)} ${a.desc}${a.required ? " (required)" : ""}`);
  }
  lines.push("");
  lines.push("FLAGS:");
  for (const f of cmd.flags) lines.push(flagLine(f));
  lines.push("");
  lines.push("  global:");
  for (const f of GLOBAL_FLAGS) lines.push(flagLine(f));
  return lines.join("\n");
}
