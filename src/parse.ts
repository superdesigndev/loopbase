// Spec-driven argument parser. Validates argv against a CommandSpec + globals.
// Produces a typed, validated invocation or throws a CliError. (PLAN.md → spec
// is the single source of truth.)

import { COMMANDS, GLOBAL_FLAGS, findCommand, usageString, type CommandSpec, type FlagSpec } from "./spec.ts";
import { CliError, EXIT, errInvalidValue, errUsage, type OutputMode } from "./output.ts";
import { BIN_NAME } from "./constants.ts";

export interface Invocation {
  command: CommandSpec;
  args: Record<string, string>;
  flags: Record<string, string | number | boolean>;
  mode: OutputMode;
  wantHelp: boolean;
}

export interface ParseResult {
  kind: "help-top" | "help-command" | "run";
  command?: CommandSpec;
  invocation?: Invocation;
}

function flagByName(cmd: CommandSpec, name: string): FlagSpec | undefined {
  return [...GLOBAL_FLAGS, ...cmd.flags].find((f) => f.name === name);
}

function coerce(flag: FlagSpec, raw: string): string | number | boolean {
  switch (flag.type) {
    case "bool":
      return raw === "" || raw === "true" ? true : raw === "false" ? false : true;
    case "int": {
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n)) throw errUsage(`--${flag.name} expects an integer, got ${JSON.stringify(raw)}`);
      return n;
    }
    case "enum":
      if (!flag.enumValues!.includes(raw)) throw errInvalidValue(`--${flag.name}`, raw, flag.enumValues!);
      return raw;
    default:
      return raw;
  }
}

export function parse(argv: string[]): ParseResult {
  const tokens = [...argv];
  // Find the command (first token that isn't a flag).
  let commandName: string | undefined;
  const rest: string[] = [];
  let topHelp = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!commandName && (t === "--help" || t === "-h")) topHelp = true;
    else if (!commandName && !t.startsWith("-")) commandName = t;
    else rest.push(t);
  }

  if (!commandName) {
    if (topHelp || true) return { kind: "help-top" };
  }

  const command = findCommand(commandName!);
  if (!command) {
    throw new CliError(EXIT.USAGE, {
      error: "usage",
      message: `unknown command ${JSON.stringify(commandName)}`,
      valid: COMMANDS.filter((c) => !c.hidden).map((c) => c.name),
      hint: `run \`${BIN_NAME} --help\` to see commands`,
    });
  }

  // Parse flags + positionals from `rest`.
  const flags: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  let wantHelp = false;

  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === "--help" || t === "-h") {
      wantHelp = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const flag = flagByName(command, name);
      if (!flag) {
        throw new CliError(EXIT.USAGE, {
          error: "usage",
          message: `unknown flag --${name}`,
          valid: [...command.flags, ...GLOBAL_FLAGS].map((f) => `--${f.name}`),
          usage: usageString(command),
          hint: `run \`${BIN_NAME} ${command.name} --help\` for flag details`,
        });
      }
      let rawVal: string;
      if (eq >= 0) rawVal = t.slice(eq + 1);
      else if (flag.type === "bool") rawVal = "";
      else {
        const next = rest[i + 1];
        if (next === undefined || (next.startsWith("--") && next.length > 2)) {
          throw errUsage(`--${name} expects a value`, `${BIN_NAME} ${command.name} --${name} <value>`);
        }
        rawVal = next;
        i++;
      }
      flags[name] = coerce(flag, rawVal);
    } else {
      positionals.push(t);
    }
  }

  // Map positionals to declared args.
  const args: Record<string, string> = {};
  command.args.forEach((a, idx) => {
    const v = positionals[idx];
    if (v !== undefined) args[a.name] = v;
    else if (a.required && !wantHelp) {
      throw errUsage(`missing required argument <${a.name}>`, usageString(command));
    }
  });
  if (positionals.length > command.args.length && !wantHelp) {
    throw errUsage(`unexpected extra argument ${JSON.stringify(positionals[command.args.length])}`);
  }

  // Output mode: JSON default; --text flips it off; --json forces it on.
  const mode: OutputMode = { json: flags.text === true ? false : true };

  if (wantHelp) return { kind: "help-command", command };
  return { kind: "run", command, invocation: { command, args, flags, mode, wantHelp } };
}
