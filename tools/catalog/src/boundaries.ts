/**
 * `boundaries`: imports must follow declared dependencies and product boundaries.
 *
 * Rules (ids are stable; CI and agents match on them):
 *  - undeclared-import          @bsh/x imported but not in depends_on
 *  - unknown-workspace-import   @bsh/x imported but no workspace package has that name
 *  - cross-product-import       products/<a> imports products/<b>
 *  - platform-imports-product   platform/* imports products/*
 *  - relative-escape            a relative/absolute import resolves outside the package root
 *  - depends-on-cross-product / depends-on-platform-to-product   the same policies, at manifest level
 *
 * Packages under a nested workspace root (another repository vendored at e.g. `deps/scribbit`) are known
 * targets for imports and depends_on, but their own files are not scanned here: their repository lints them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CheckResult, Diagnostic } from "./types.js";
import { PRODUCT_SLUGS } from "./types.js";
import { sortDiagnostics } from "./validate.js";
import { IGNORED_DIRS, isRecord, manifestLine, stringArray, toPosix, type Workspace, type WorkspacePackage } from "./workspace.js";

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export type ImportKind = "import" | "re-export" | "dynamic" | "require" | "type-import";

export interface ImportRef {
  specifier: string;
  line: number;
  kind: ImportKind;
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = path.extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Extract every module specifier from source text using the TypeScript parser (comment/string safe). */
export function extractImports(source: string, fileName = "file.ts"): ImportRef[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const out: ImportRef[] = [];
  const add = (lit: ts.Node, kind: ImportKind): void => {
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) {
      out.push({ specifier: lit.text, kind, line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1 });
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) add(n.moduleSpecifier, "import");
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier) add(n.moduleSpecifier, "re-export");
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) add(n.moduleReference.expression, "require");
    else if (ts.isCallExpression(n) && n.arguments.length > 0) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) add(n.arguments[0]!, "dynamic");
      else if (ts.isIdentifier(n.expression) && n.expression.text === "require") add(n.arguments[0]!, "require");
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal, "type-import");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Source files of a package, skipping build output, nested workspace packages and any nested directory that is
 * its own package or workspace root (e.g. test fixture mini-repos): those are separate units, not this package.
 */
export function listSourceFiles(pkg: WorkspacePackage, otherRoots: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const rec = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name) || otherRoots.has(child)) continue;
        if (existsSync(path.join(child, "package.json")) || existsSync(path.join(child, "pnpm-workspace.yaml"))) continue;
        rec(child);
      } else if (e.isFile() && SOURCE_EXTENSIONS.has(path.extname(e.name))) {
        out.push(child);
      }
    }
  };
  rec(pkg.absDir);
  return out.sort();
}

/** `@bsh/foo/sub/path` -> `@bsh/foo`. */
export function packageOfSpecifier(spec: string): string {
  const [scope, name] = spec.split("/");
  return `${scope}/${name}`;
}

function productOf(pkg: WorkspacePackage): string | undefined {
  const m = pkg.manifest;
  if (isRecord(m) && typeof m.product === "string") return m.product;
  const segs = pkg.dirInWorkspace.split("/");
  if (segs[0] === "platform") return "platform";
  if (segs[0] === "products") return segs[1];
  if (segs[0] === "tools") return "tooling";
  return undefined;
}

/** Policy verdict for `from` depending on `to`, independent of depends_on. */
function policyViolation(fromProduct: string | undefined, toProduct: string | undefined): "cross-product" | "platform-to-product" | null {
  if (!fromProduct || !toProduct || !PRODUCT_SLUGS.has(toProduct)) return null;
  if (fromProduct === "platform") return "platform-to-product";
  if (PRODUCT_SLUGS.has(fromProduct) && fromProduct !== toProduct) return "cross-product";
  return null;
}

export function checkBoundaries(ws: Workspace, scope = "@bsh/"): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const roots = new Map(ws.packages.map((p) => [p.absDir, p] as const));
  let files = 0;
  let imports = 0;
  let external = 0;

  for (const pkg of ws.packages) {
    if (pkg.external) {
      external++;
      continue;
    }
    const m = isRecord(pkg.manifest) ? pkg.manifest : {};
    const component = typeof m.name === "string" ? m.name : pkg.packageJson.name ?? pkg.dir;
    const ownName = pkg.packageJson.name;
    const ownProduct = productOf(pkg);
    const dependsOn = new Set(stringArray(m.depends_on));

    // Manifest-level policy: a declared edge that the architecture forbids.
    stringArray(m.depends_on).forEach((dep, i) => {
      const target = ws.byName.get(dep);
      const v = target ? policyViolation(ownProduct, productOf(target)) : null;
      if (v && pkg.manifestPath) {
        diagnostics.push({
          severity: "error",
          rule: v === "cross-product" ? "depends-on-cross-product" : "depends-on-platform-to-product",
          file: pkg.manifestPath,
          line: manifestLine(pkg, ["depends_on", i]),
          component,
          message: `depends_on "${dep}" (${productOf(target!)}) is forbidden from ${ownProduct}: products share code only via platform/ and contracts/`,
        });
      }
    });

    const otherRoots = new Set([...roots.keys()].filter((r) => r !== pkg.absDir && r.startsWith(pkg.absDir + path.sep)));
    for (const abs of listSourceFiles(pkg, otherRoots)) {
      files++;
      const rel = toPosix(path.relative(ws.root, abs));
      const refs = extractImports(readFileSync(abs, "utf8"), abs);
      for (const ref of refs) {
        const spec = ref.specifier;
        const report = (rule: string, message: string): void => {
          diagnostics.push({ severity: "error", rule, file: rel, line: ref.line, component, message });
        };
        if (spec.startsWith(scope)) {
          imports++;
          const target = packageOfSpecifier(spec);
          if (target === ownName) continue;
          const targetPkg = ws.byName.get(target);
          if (!targetPkg) {
            report("unknown-workspace-import", `${ref.kind} of "${spec}": no workspace package named ${target}`);
            continue;
          }
          const v = policyViolation(ownProduct, productOf(targetPkg));
          if (v === "cross-product") {
            report("cross-product-import", `${ref.kind} of "${spec}": ${ownProduct} may not import ${productOf(targetPkg)} code; go through contracts/ or move shared code to platform/`);
          } else if (v === "platform-to-product") {
            report("platform-imports-product", `${ref.kind} of "${spec}": platform/ may not import product code (${productOf(targetPkg)})`);
          } else if (!dependsOn.has(target)) {
            report("undeclared-import", `${ref.kind} of "${spec}": ${target} is not in depends_on of ${component}`);
          }
        } else if (spec.startsWith(".") || path.isAbsolute(spec)) {
          imports++;
          const resolved = path.resolve(path.dirname(abs), spec);
          const inside = path.relative(pkg.absDir, resolved);
          const escapes = inside.startsWith("..") || path.isAbsolute(inside);
          const intoNested = [...otherRoots].find((r) => resolved === r || resolved.startsWith(r + path.sep));
          if (escapes || intoNested) {
            const landed = [...roots.entries()]
              .filter(([r]) => r !== pkg.absDir && (resolved === r || resolved.startsWith(r + path.sep)))
              .map(([, p]) => p.packageJson.name ?? p.dir)[0];
            report(
              "relative-escape",
              `${ref.kind} of "${spec}" resolves outside the package root (${toPosix(path.relative(ws.root, resolved)) || "."})` +
                (landed ? ` into ${landed}; import it by package name and add it to depends_on` : ""),
            );
          }
        }
      }
    }
  }

  return { command: "boundaries", diagnostics: sortDiagnostics(diagnostics), stats: { packages: ws.packages.length, external, files, imports } };
}
