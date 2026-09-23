/**
 * `codeowners`: generate .github/CODEOWNERS from component owners, so review routing can never drift
 * from the manifests. GitHub applies the LAST matching rule, so fallbacks come first.
 * External components (under a nested workspace root such as a submodule) are owned in their own repository
 * and are skipped, as are the contracts they provide.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, Diagnostic } from "./types.js";
import { buildCatalog } from "./catalog.js";
import type { Workspace } from "./workspace.js";

export const CODEOWNERS_FILE = ".github/CODEOWNERS";
export const DEFAULT_ORG = "blockspace-holdings";
/** Owner of everything no component claims (repo plumbing, schemas, ADRs). */
export const FALLBACK_OWNER = "team-platform";

const SHARED_PATHS = ["/.github/", "/schemas/", "/templates/", "/docs/", "/catalog/", "/contracts/", "/tools/"];

export function renderCodeowners(ws: Workspace, org: string = DEFAULT_ORG): string {
  const catalog = buildCatalog(ws, "");
  const handle = (team: string): string => `@${org}/${team}`;
  const components = catalog.components.filter((c) => !c.external);
  const isExternalPath = (p: string): boolean => ws.externalRoots.some((r) => p === r || p.startsWith(`${r}/`));
  const ownersOf = new Map(components.map((c) => [c.name, String(c.owner)]));
  const rows: [string, string][] = [["*", handle(FALLBACK_OWNER)]];
  for (const p of SHARED_PATHS) rows.push([p, handle(FALLBACK_OWNER)]);

  // A contract is owned by the teams that provide it (changing it changes their promise).
  for (const c of catalog.contracts) {
    if (c.kind === "event" || !c.exists || isExternalPath(c.path)) continue;
    const teams = [...new Set(c.providers.map((n) => ownersOf.get(n)).filter((t): t is string => !!t))].sort();
    if (teams.length > 0) rows.push([`/${c.path}`, teams.map(handle).join(" ")]);
  }
  for (const c of [...components].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    rows.push([`/${c.path}/`, handle(String(c.owner))]);
  }
  const width = Math.max(...rows.map(([p]) => p.length)) + 2;
  return [
    "# GENERATED from component.yaml `owner` fields by `pnpm --filter @bsh/catalog-tool run codeowners`.",
    "# Do not edit by hand; change the manifest instead. CI runs the same command with --check.",
    "# GitHub applies the last matching pattern, so fallbacks come first.",
    "",
    ...rows.map(([p, o]) => `${p.padEnd(width)}${o}`),
    "",
  ].join("\n");
}

export function runCodeowners(ws: Workspace, opts: { check?: boolean; org?: string } = {}): CheckResult {
  const file = path.join(ws.root, CODEOWNERS_FILE);
  const next = renderCodeowners(ws, opts.org);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  const diagnostics: Diagnostic[] = [];
  if (opts.check) {
    if (current !== next) {
      diagnostics.push({
        severity: "error",
        rule: "codeowners-stale",
        file: CODEOWNERS_FILE,
        message: "CODEOWNERS is out of date with component owners; run `pnpm --filter @bsh/catalog-tool run codeowners`",
      });
    }
  } else if (current !== next) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return { command: "codeowners", diagnostics, stats: { rules: next.split("\n").filter((l) => l && !l.startsWith("#")).length } };
}
