/**
 * `validate`: every workspace package has a component.yaml that satisfies the schema and agrees with
 * its package.json and the files it points at.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import type { CheckResult, Diagnostic } from "./types.js";
import {
  MANIFEST_FILE,
  SCHEMA_FILE,
  declaredWorkspaceDeps,
  isRecord,
  manifestLine,
  stringArray,
  type Workspace,
  type WorkspacePackage,
} from "./workspace.js";

export function loadSchema(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, SCHEMA_FILE), "utf8")) as Record<string, unknown>;
}

/** Strip a `#fragment` from a contract reference. */
export const contractFile = (ref: string): string => ref.split("#")[0]!;

/**
 * Repo-relative path of a contract referenced by a package. Manifest paths are relative to the workspace root
 * that owns the package, so `contracts/x.yaml` in an external package under `deps/plat` is `deps/plat/contracts/x.yaml`
 * here; a `deps/<name>/contracts/...` reference is already repo-relative.
 */
export function contractPathFor(pkg: WorkspacePackage, ref: string): string {
  const rel = contractFile(ref);
  return pkg.workspaceRoot && !rel.startsWith("deps/") ? `${pkg.workspaceRoot}/${rel}` : rel;
}

/** Product implied by a package's location, or undefined for locations with no convention. */
export function productForPath(dir: string): string | undefined {
  const segs = dir.split("/");
  if (segs[0] === "platform") return "platform";
  if (segs[0] === "tools") return "tooling";
  if (segs[0] === "products" && segs[1]) return segs[1];
  return undefined;
}

function formatAjvError(err: ErrorObject): string {
  const where = err.instancePath || "(root)";
  if (err.keyword === "additionalProperties") {
    return `${where}: unknown property "${String((err.params as { additionalProperty: string }).additionalProperty)}"`;
  }
  if (err.keyword === "enum") {
    return `${where}: must be one of ${(err.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return `${where}: ${err.message ?? err.keyword}`;
}

function ajvKeyPath(err: ErrorObject): (string | number)[] {
  const parts = err.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (err.keyword === "additionalProperties") {
    parts.push((err.params as { additionalProperty: string }).additionalProperty);
  }
  return parts;
}

export function validateWorkspace(ws: Workspace, schema: Record<string, unknown> = loadSchema(ws.root)): CheckResult {
  const compile = (s: Record<string, unknown>) => new Ajv2020({ allErrors: true, strict: false }).compile(s);
  const validateOuter = compile(schema);
  // An external package is validated against the schema of the workspace root that owns it (that repository's
  // rules), falling back to ours when the nested root ships none. Each schema gets its own Ajv instance: the
  // copies share one `$id`, which a single instance would reject as a duplicate.
  const validators = new Map<string, typeof validateOuter>([["", validateOuter]]);
  const validatorFor = (root: string) => {
    let v = validators.get(root);
    if (!v) {
      let nested = schema;
      try {
        nested = loadSchema(path.join(ws.root, root));
      } catch {
        /* no schema in the nested root: use ours */
      }
      validators.set(root, (v = compile(nested)));
    }
    return v;
  };
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, WorkspacePackage[]>();
  const packageNames = new Map<string, WorkspacePackage[]>();
  let valid = 0;
  let external = 0;

  for (const pkg of ws.packages) {
    if (pkg.external) external++;
    const group = pkg.external ? ({ group: "external" } as const) : {};
    diagnostics.push(...pkg.loadErrors.map((d) => ({ ...d, ...group })));
    const pj = pkg.packageJson;
    const pkgName = pj.name;
    if (pkgName) packageNames.set(pkgName, [...(packageNames.get(pkgName) ?? []), pkg]);
    else if (pkg.loadErrors.length === 0) {
      diagnostics.push({ severity: "error", rule: "package-json-no-name", file: `${pkg.dir}/package.json`, ...group, message: "package.json has no \"name\"" });
    }

    if (!pkg.manifestPath) {
      diagnostics.push({
        severity: "error",
        rule: "manifest-missing",
        file: `${pkg.dir}/${MANIFEST_FILE}`,
        component: pkgName,
        ...group,
        message: `Workspace package ${pkgName ?? pkg.dir} has no ${MANIFEST_FILE} (copy one from templates/)`,
      });
      continue;
    }
    if (pkg.manifest === undefined) continue; // YAML error already reported
    const file = pkg.manifestPath;
    const before = diagnostics.length;

    const validateManifest = validatorFor(pkg.workspaceRoot);
    if (!validateManifest(pkg.manifest)) {
      for (const err of validateManifest.errors ?? []) {
        diagnostics.push({
          severity: "error",
          rule: "manifest-schema",
          file,
          line: manifestLine(pkg, ajvKeyPath(err)),
          component: pkgName,
          ...group,
          message: formatAjvError(err),
        });
      }
    }
    if (!isRecord(pkg.manifest)) continue;
    const m = pkg.manifest;
    const component = typeof m.name === "string" ? m.name : pkgName;
    const err = (rule: string, keyPath: (string | number)[], message: string): void => {
      diagnostics.push({ severity: "error", rule, file, line: manifestLine(pkg, keyPath), component, ...group, message });
    };

    if (typeof m.name === "string") names.set(m.name, [...(names.get(m.name) ?? []), pkg]);

    if (typeof m.package === "string" && pkgName && m.package !== pkgName) {
      err("package-name-mismatch", ["package"], `package "${m.package}" does not match package.json name "${pkgName}"`);
    }

    const expectedProduct = productForPath(pkg.dirInWorkspace);
    if (expectedProduct && typeof m.product === "string" && m.product !== expectedProduct) {
      err("product-path-mismatch", ["product"], `product "${m.product}" but the component lives under ${pkg.dir} (expected "${expectedProduct}")`);
    }

    // depends_on <-> package.json workspace deps, both directions.
    const dependsOn = stringArray(m.depends_on);
    const declared = new Set(declaredWorkspaceDeps(pj));
    dependsOn.forEach((dep, i) => {
      if (dep === pkgName) err("depends-on-self", ["depends_on", i], `depends_on lists the component itself (${dep})`);
      else if (!ws.byName.has(dep)) err("depends-on-unknown", ["depends_on", i], `depends_on "${dep}" is not a workspace package`);
      else if (!declared.has(dep)) {
        err("depends-on-not-in-package-json", ["depends_on", i], `depends_on "${dep}" is not declared in package.json dependencies (add "${dep}": "workspace:*")`);
      }
    });
    const dependsSet = new Set(dependsOn);
    for (const dep of declared) {
      if (!dependsSet.has(dep)) {
        err("package-json-dep-undeclared", ["depends_on"], `package.json depends on "${dep}" but component.yaml depends_on does not list it`);
      }
    }

    // Contract paths are relative to the owning workspace root and must exist (contract first, then code).
    for (const field of ["provides", "consumes"] as const) {
      stringArray(m[field]).forEach((ref, i) => {
        if (ref.startsWith("events:")) return;
        const rel = contractPathFor(pkg, ref);
        if (!existsSync(path.join(ws.root, rel))) err("contract-missing", [field, i], `${field} "${ref}": file ${rel} does not exist`);
      });
    }

    // Component-relative files.
    for (const field of ["env_schema", "runbook", "docs"] as const) {
      const v = m[field];
      if (typeof v !== "string") continue;
      const abs = path.resolve(pkg.absDir, v);
      if (!existsSync(abs)) err("path-missing", [field], `${field} "${v}" does not exist (resolved ${path.relative(ws.root, abs).split(path.sep).join("/")})`);
    }

    // Standard verbs must map to real scripts.
    if (isRecord(m.commands)) {
      for (const [verb, script] of Object.entries(m.commands)) {
        if (typeof script === "string" && !(pj.scripts && script in pj.scripts)) {
          err("command-script-missing", ["commands", verb], `commands.${verb} -> "${script}" is not a script in package.json`);
        }
      }
    }

    if (diagnostics.length === before) valid++;
  }

  for (const [name, pkgs] of names) {
    if (pkgs.length > 1) {
      for (const p of pkgs) {
        diagnostics.push({
          severity: "error",
          rule: "name-duplicate",
          file: p.manifestPath!,
          line: manifestLine(p, ["name"]),
          component: name,
          message: `component name "${name}" is used by ${pkgs.map((x) => x.dir).join(", ")}`,
        });
      }
    }
  }
  for (const [name, pkgs] of packageNames) {
    if (pkgs.length > 1) {
      for (const p of pkgs) {
        diagnostics.push({
          severity: "error",
          rule: "package-duplicate",
          file: `${p.dir}/package.json`,
          component: name,
          message: `package name "${name}" is used by ${pkgs.map((x) => x.dir).join(", ")}`,
        });
      }
    }
  }

  return { command: "validate", diagnostics: sortDiagnostics(diagnostics), stats: { packages: ws.packages.length, valid, external } };
}

export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message),
  );
}
