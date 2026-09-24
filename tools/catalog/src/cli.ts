#!/usr/bin/env node
/**
 * bsh-catalog: validate | boundaries | catalog | codeowners | readiness
 *   [--json] [--check] [--root <dir>] [--org <gh-org>] [--min-readme-lines <n>]
 *
 * Exit codes: 0 ok, 1 findings (errors), 2 usage / internal error.
 * `--json` prints exactly one JSON object on stdout:
 *   { command, ok, counts: { errors, warnings }, stats, diagnostics: [{severity, rule, file, line?, component?, message}] }
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundaries } from "./boundaries.js";
import { runCatalog } from "./catalog.js";
import { runCodeowners } from "./codeowners.js";
import { checkReadiness, DEFAULT_MIN_README_LINES } from "./readiness.js";
import type { CheckResult } from "./types.js";
import { validateWorkspace } from "./validate.js";
import { findRepoRoot, loadWorkspace } from "./workspace.js";

export const COMMANDS = ["validate", "boundaries", "catalog", "codeowners", "readiness"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  json: boolean;
  check: boolean;
  root?: string;
  org?: string;
  minReadmeLines?: number;
}

const USAGE = `usage: bsh-catalog <${COMMANDS.join("|")}> [--json] [--check] [--root <dir>] [--org <github-org>] [--min-readme-lines <n>]

  validate     every workspace package has a schema-valid component.yaml that matches package.json
  boundaries   imports follow depends_on; no cross-product or platform->product imports; no relative escapes
  catalog      write catalog/catalog.json + catalog/CATALOG.md (--check: fail if stale)
  codeowners   write .github/CODEOWNERS from component owners (--check: fail if stale)
  readiness    open-source readiness: LICENSE (Apache-2.0), NOTICE, community files, issue forms, security
               workflows; every package has license, a README.md with a Quickstart heading
               (>= --min-readme-lines non-blank lines, default ${DEFAULT_MIN_README_LINES}) and a lifecycle`;

export function parseArgs(argv: string[]): CliOptions | string {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") return USAGE;
  if (!(COMMANDS as readonly string[]).includes(command)) return `unknown command "${command}"\n\n${USAGE}`;
  const opts: CliOptions = { command: command as Command, json: false, check: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") opts.json = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--root" || a === "--org") {
      const v = rest[++i];
      if (!v) return `${a} needs a value\n\n${USAGE}`;
      if (a === "--root") opts.root = v;
      else opts.org = v;
    } else if (a === "--min-readme-lines") {
      const v = rest[++i];
      const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN;
      if (!Number.isInteger(n)) return `--min-readme-lines needs a non-negative integer\n\n${USAGE}`;
      opts.minReadmeLines = n;
    } else if (a === "--") continue;
    else return `unknown option "${a}"\n\n${USAGE}`;
  }
  return opts;
}

export function run(opts: CliOptions): CheckResult {
  const root = opts.root ? path.resolve(opts.root) : findRepoRoot(process.env.INIT_CWD ?? process.cwd());
  const ws = loadWorkspace(root);
  switch (opts.command) {
    case "validate":
      return validateWorkspace(ws);
    case "boundaries":
      return checkBoundaries(ws);
    case "catalog": {
      const { catalog: _c, ...res } = runCatalog(ws, { check: opts.check });
      return res;
    }
    case "codeowners":
      return runCodeowners(ws, { check: opts.check, org: opts.org ?? process.env.CODEOWNERS_ORG });
    case "readiness":
      return checkReadiness(ws, { minReadmeLines: opts.minReadmeLines });
  }
}

export function formatHuman(res: CheckResult, check = false): string {
  const lines = res.diagnostics.map((d) => {
    const loc = d.line ? `${d.file}:${d.line}` : d.file;
    return `${d.severity}[${d.rule}] ${loc}: ${d.message}${d.component ? `  (${d.component})` : ""}`;
  });
  const errors = res.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = res.diagnostics.length - errors;
  const stats = Object.entries(res.stats)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const verdict = errors === 0 ? "ok" : "FAILED";
  lines.push(`${res.command}${check ? " --check" : ""}: ${verdict} - ${errors} error(s), ${warnings} warning(s) [${stats}]`);
  return lines.join("\n");
}

export function toJson(res: CheckResult): string {
  const errors = res.diagnostics.filter((d) => d.severity === "error").length;
  return JSON.stringify(
    { command: res.command, ok: errors === 0, counts: { errors, warnings: res.diagnostics.length - errors }, stats: res.stats, diagnostics: res.diagnostics },
    null,
    2,
  );
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    const help = argv[0] === "-h" || argv[0] === "--help" || argv.length === 0;
    (help && argv.length > 0 ? console.log : console.error)(parsed);
    return help && argv.length > 0 ? 0 : 2;
  }
  let res: CheckResult;
  try {
    res = run(parsed);
  } catch (e) {
    const message = (e as Error).message;
    if (parsed.json) console.log(JSON.stringify({ command: parsed.command, ok: false, fatal: message }));
    else console.error(`${parsed.command}: fatal: ${message}`);
    return 2;
  }
  console.log(parsed.json ? toJson(res) : formatHuman(res, parsed.check));
  return res.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
