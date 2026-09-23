/**
 * Workspace discovery: find the repo root, expand pnpm-workspace.yaml globs, load package.json and
 * component.yaml for every package. Pure filesystem reads; no pnpm invocation, so it works in CI
 * before `pnpm install` and against fixture repos in tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML, { LineCounter, type Document } from "yaml";
import type { Diagnostic, PackageJson } from "./types.js";

export const MANIFEST_FILE = "component.yaml";
export const SCHEMA_FILE = "schemas/component.schema.json";

/** Directories never descended into, anywhere. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  ".turbo",
  ".next",
  ".vite",
]);

export interface WorkspacePackage {
  /** Repo-relative POSIX directory, e.g. `products/degent/services/mint`. */
  dir: string;
  absDir: string;
  /**
   * True when the package lives under a NESTED workspace root: a directory strictly between the repo root and
   * the package that has its own `pnpm-workspace.yaml` (e.g. a git submodule at `deps/scribbit`). External
   * packages are known workspace packages (they can be imported and listed in `depends_on`) but belong to
   * another repository: their manifest-relative paths resolve against `workspaceRoot`, their sources are not
   * linted here and they do not appear in CODEOWNERS.
   */
  external: boolean;
  /** Repo-relative POSIX path of the workspace root that owns the package: `""` for the repo itself. */
  workspaceRoot: string;
  /** Directory of the package relative to `workspaceRoot`, e.g. `platform/inscription` for `deps/scribbit/platform/inscription`. */
  dirInWorkspace: string;
  packageJson: PackageJson;
  /** Repo-relative path of component.yaml, or null when missing. */
  manifestPath: string | null;
  /** Parsed YAML (unvalidated), undefined when missing or unparseable. */
  manifest: unknown;
  manifestDoc?: Document.Parsed;
  lineCounter?: LineCounter;
  /** Load-time problems (unreadable package.json, YAML syntax errors). */
  loadErrors: Diagnostic[];
}

export interface Workspace {
  root: string;
  patterns: string[];
  packages: WorkspacePackage[];
  /** Repo-relative POSIX paths of nested workspace roots that hold at least one package, sorted. */
  externalRoots: string[];
  /** package name -> package, for names that are unique. */
  byName: Map<string, WorkspacePackage>;
}

export const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Walk up from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml found at or above ${start}`);
    dir = parent;
  }
}

function subdirs(abs: string): string[] {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

function segmentRegex(seg: string): RegExp {
  const body = seg
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${body}$`);
}

/** Does repo-relative `rel` match a pnpm-style glob (supports `*` and `**`)? */
export function matchGlob(pattern: string, rel: string): boolean {
  const ps = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const rs = rel.split("/").filter(Boolean);
  const rec = (i: number, j: number): boolean => {
    if (i === ps.length) return j === rs.length;
    const seg = ps[i]!;
    if (seg === "**") {
      for (let k = j; k <= rs.length; k++) if (rec(i + 1, k)) return true;
      return false;
    }
    if (j >= rs.length) return false;
    return segmentRegex(seg).test(rs[j]!) && rec(i + 1, j + 1);
  };
  return rec(0, 0);
}

/** Expand workspace globs to repo-relative directories that contain a package.json. */
export function expandWorkspaceGlobs(root: string, patterns: string[]): string[] {
  const includes = patterns.filter((p) => !p.startsWith("!"));
  const excludes = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const found = new Set<string>();
  for (const pattern of includes) {
    const segs = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean);
    const rec = (rel: string[], i: number): void => {
      const abs = path.join(root, ...rel);
      if (i === segs.length) {
        if (rel.length > 0 && existsSync(path.join(abs, "package.json"))) found.add(rel.join("/"));
        return;
      }
      const seg = segs[i]!;
      if (seg === "**") {
        rec(rel, i + 1);
        for (const d of subdirs(abs)) rec([...rel, d], i);
        return;
      }
      if (!seg.includes("*")) {
        const next = path.join(abs, seg);
        if (existsSync(next) && statSync(next).isDirectory()) rec([...rel, seg], i + 1);
        return;
      }
      const re = segmentRegex(seg);
      for (const d of subdirs(abs)) if (re.test(d)) rec([...rel, d], i + 1);
    };
    rec([], 0);
  }
  return [...found].filter((d) => !excludes.some((ex) => matchGlob(ex, d))).sort();
}

/**
 * The nearest directory strictly between `root` and `root/dir` that contains its own pnpm-workspace.yaml,
 * as a repo-relative POSIX path, or `""` when the package belongs to the repo root's workspace.
 */
export function nestedWorkspaceRoot(root: string, dir: string): string {
  const segs = dir.split("/").filter(Boolean);
  for (let n = segs.length - 1; n >= 1; n--) {
    const candidate = segs.slice(0, n).join("/");
    if (existsSync(path.join(root, candidate, "pnpm-workspace.yaml"))) return candidate;
  }
  return "";
}

function loadPackage(root: string, dir: string): WorkspacePackage {
  const absDir = path.join(root, dir);
  const loadErrors: Diagnostic[] = [];
  const workspaceRoot = nestedWorkspaceRoot(root, dir);
  const dirInWorkspace = workspaceRoot ? dir.slice(workspaceRoot.length + 1) : dir;
  let packageJson: PackageJson = {};
  try {
    packageJson = JSON.parse(readFileSync(path.join(absDir, "package.json"), "utf8")) as PackageJson;
  } catch (e) {
    loadErrors.push({
      severity: "error",
      rule: "package-json-invalid",
      file: `${dir}/package.json`,
      message: `Cannot parse package.json: ${(e as Error).message}`,
    });
  }
  const pkg: WorkspacePackage = {
    dir,
    absDir,
    external: workspaceRoot !== "",
    workspaceRoot,
    dirInWorkspace,
    packageJson,
    manifestPath: null,
    manifest: undefined,
    loadErrors,
  };
  const manifestAbs = path.join(absDir, MANIFEST_FILE);
  if (!existsSync(manifestAbs)) return pkg;
  pkg.manifestPath = `${dir}/${MANIFEST_FILE}`;
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(readFileSync(manifestAbs, "utf8"), { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      const pos = lineCounter.linePos(err.pos[0]);
      loadErrors.push({
        severity: "error",
        rule: "manifest-yaml-invalid",
        file: pkg.manifestPath,
        line: pos.line,
        component: packageJson.name,
        message: `YAML syntax error: ${err.message.split("\n")[0]}`,
      });
    }
    return pkg;
  }
  pkg.manifest = doc.toJS();
  pkg.manifestDoc = doc;
  pkg.lineCounter = lineCounter;
  return pkg;
}

export function loadWorkspace(root: string): Workspace {
  const wsFile = path.join(root, "pnpm-workspace.yaml");
  const parsed = YAML.parse(readFileSync(wsFile, "utf8")) as { packages?: unknown } | null;
  const patterns = Array.isArray(parsed?.packages) ? parsed.packages.filter((p): p is string => typeof p === "string") : [];
  const packages = expandWorkspaceGlobs(root, patterns).map((d) => loadPackage(root, d));
  const byName = new Map<string, WorkspacePackage>();
  for (const p of packages) if (p.packageJson.name && !byName.has(p.packageJson.name)) byName.set(p.packageJson.name, p);
  const externalRoots = [...new Set(packages.filter((p) => p.external).map((p) => p.workspaceRoot))].sort();
  return { root, patterns, packages, byName, externalRoots };
}

/** 1-based line of a manifest node addressed by a key path (falls back to line 1). */
export function manifestLine(pkg: WorkspacePackage, keyPath: (string | number)[]): number {
  if (!pkg.manifestDoc || !pkg.lineCounter) return 1;
  for (let n = keyPath.length; n > 0; n--) {
    const node = pkg.manifestDoc.getIn(keyPath.slice(0, n), true) as { range?: [number, number, number] } | undefined;
    if (node && typeof node === "object" && node.range) return pkg.lineCounter.linePos(node.range[0]).line;
  }
  return 1;
}

/** All `@bsh/*` names a package.json declares, across every dependency field. */
export function declaredWorkspaceDeps(pj: PackageJson, scope = "@bsh/"): string[] {
  const names = new Set<string>();
  for (const field of [pj.dependencies, pj.devDependencies, pj.peerDependencies, pj.optionalDependencies]) {
    for (const name of Object.keys(field ?? {})) if (name.startsWith(scope)) names.add(name);
  }
  return [...names].sort();
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
