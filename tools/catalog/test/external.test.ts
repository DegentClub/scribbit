/**
 * Packages under a NESTED workspace root (a directory between the repo root and the package with its own
 * pnpm-workspace.yaml, e.g. the platform vendored as a git submodule at deps/scribbit) are external: known to
 * the outer repo, but owned, linted and code-owned by their own repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoundaries } from "../src/boundaries.js";
import { buildCatalog, contractKind, readGitmodules, runCatalog, submoduleCommit } from "../src/catalog.js";
import { CODEOWNERS_FILE, renderCodeowners, runCodeowners } from "../src/codeowners.js";
import { validateWorkspace } from "../src/validate.js";
import { loadWorkspace, nestedWorkspaceRoot } from "../src/workspace.js";
import { errorsOf, fixture, rules, workspace } from "./helpers.js";

const NOW = "2026-09-23T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Turn the fixture copy into a git repo whose HEAD pins deps/plat as a gitlink (no network, no clone). */
function gitWithSubmodule(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".gitmodules", "pnpm-workspace.yaml", "products", "contracts");
  git("update-index", "--add", "--cacheinfo", `160000,${SHA},deps/plat`);
  git("commit", "-q", "-m", "pin");
}

describe("nested workspace roots", () => {
  it("marks packages under deps/plat external and remembers their own root", () => {
    const ws = workspace("external-workspace");
    expect(ws.packages.map((p) => `${p.dir}:${p.external}:${p.workspaceRoot}:${p.dirInWorkspace}`)).toEqual([
      "deps/plat/platform/core:true:deps/plat:platform/core",
      "products/degent/services/api:false::products/degent/services/api",
    ]);
    expect(ws.externalRoots).toEqual(["deps/plat"]);
    expect(ws.byName.get("@bsh/core")?.external).toBe(true);
    expect(nestedWorkspaceRoot(ws.root, "products/degent/services/api")).toBe("");
    expect(nestedWorkspaceRoot(ws.root, "deps/plat/platform/core")).toBe("deps/plat");
  });

  it("validate resolves external manifests against the nested root and reports them under the external group", () => {
    const res = validateWorkspace(workspace("external-workspace"));
    // core's provides (contracts/asyncapi/platform-events.yaml) exists under deps/plat, not the outer root; its
    // product is derived from platform/core, not deps/plat/platform/core; the outer consumer's deps/... path resolves.
    expect(res.diagnostics).toEqual([]);
    expect(res.stats).toEqual({ packages: 2, valid: 2, external: 1 });

    const root = fixture("external-workspace");
    const m = path.join(root, "deps/plat/platform/core/component.yaml");
    const text = readFileSync(m, "utf8");
    writeFileSync(m, text.replace("contracts/asyncapi/platform-events.yaml", "contracts/asyncapi/missing.yaml").replace("./README.md", "./MISSING.md"));
    const broken = validateWorkspace(loadWorkspace(root));
    expect(rules(broken.diagnostics)).toEqual(["contract-missing", "path-missing"]);
    for (const d of broken.diagnostics) {
      expect(d.group).toBe("external");
      expect(d.file).toBe("deps/plat/platform/core/component.yaml");
    }
    expect(errorsOf(broken.diagnostics, "contract-missing")[0]!.message).toContain("deps/plat/contracts/asyncapi/missing.yaml does not exist");
  });

  it("validate uses the nested root's own schema copy (same $id) for external packages", () => {
    const root = fixture("external-workspace");
    mkdirSync(path.join(root, "deps/plat/schemas"), { recursive: true });
    const nested = JSON.parse(readFileSync(path.join(root, "schemas/component.schema.json"), "utf8")) as { properties: { lifecycle: { enum: string[] } } };
    nested.properties.lifecycle.enum = ["experimental"]; // stricter than ours: core (beta) must now fail, degent-api (beta) must not
    writeFileSync(path.join(root, "deps/plat/schemas/component.schema.json"), JSON.stringify(nested));
    const res = validateWorkspace(loadWorkspace(root));
    expect(res.diagnostics.map((d) => `${d.rule} ${d.file} ${d.group}`)).toEqual(["manifest-schema deps/plat/platform/core/component.yaml external"]);
    expect(res.diagnostics[0]!.message).toContain("/lifecycle: must be one of");
  });

  it("validate still rejects an outer consumes path outside the schema pattern", () => {
    const root = fixture("external-workspace");
    const m = path.join(root, "products/degent/services/api/component.yaml");
    writeFileSync(m, readFileSync(m, "utf8").replace("deps/plat/contracts", "vendor/plat/contracts"));
    expect(rules(validateWorkspace(loadWorkspace(root)).diagnostics)).toEqual(["contract-missing", "manifest-schema"]);
  });

  it("boundaries checks outer imports against external packages but never scans external sources", () => {
    const res = checkBoundaries(workspace("external-workspace"));
    // deps/plat/platform/core/src/index.ts has an undeclared import and a relative escape: neither is reported.
    expect(res.diagnostics.map((d) => `${d.rule} ${d.file}:${d.line}`)).toEqual(["unknown-workspace-import products/degent/services/api/src/index.ts:2"]);
    expect(res.stats).toEqual({ packages: 2, external: 1, files: 1, imports: 2 });
  });

  it("catalog lists external components with repo, commit and root, and repo-relative contract paths", () => {
    const root = fixture("external-workspace");
    gitWithSubmodule(root);
    expect(readGitmodules(root)).toEqual(new Map([["deps/plat", "https://github.com/acme/plat.git"]]));
    expect(submoduleCommit(root, "deps/plat")).toBe(SHA);
    expect(submoduleCommit(root, "products")).toBeNull();

    const c = buildCatalog(loadWorkspace(root), NOW);
    const core = c.components.find((x) => x.name === "core")!;
    expect(core.external).toEqual({ repo: "https://github.com/acme/plat.git", commit: SHA, root: "deps/plat" });
    expect(core.path).toBe("deps/plat/platform/core");
    expect(core.provides).toEqual(["deps/plat/contracts/asyncapi/platform-events.yaml"]);
    expect(core.files).toEqual({ docs: "deps/plat/platform/core/README.md" });
    expect(core.dependents).toEqual(["degent-api"]);
    expect(c.components.find((x) => x.name === "degent-api")!.external).toBeUndefined();
    expect(c.contracts).toEqual([
      { path: "contracts/openapi/api.yaml", kind: "openapi", exists: true, providers: ["degent-api"], consumers: [] },
      { path: "deps/plat/contracts/asyncapi/platform-events.yaml", kind: "asyncapi", exists: true, providers: ["core"], consumers: ["degent-api"] },
    ]);
    expect(c.edges).toContainEqual({ from: "degent-api", to: "deps/plat/contracts/asyncapi/platform-events.yaml", type: "consumes" });
    expect(contractKind("deps/plat/contracts/schemas/x.json")).toBe("json-schema");

    runCatalog(loadWorkspace(root), { now: NOW });
    expect(readFileSync(path.join(root, "catalog/CATALOG.md"), "utf8")).toContain("(external: https://github.com/acme/plat.git@0123456789ab)");
    expect(runCatalog(loadWorkspace(root), { check: true }).diagnostics).toEqual([]);
  });

  it("catalog degrades to nulls without git or .gitmodules", () => {
    const c = buildCatalog(workspace("external-workspace"), NOW);
    expect(c.components.find((x) => x.name === "core")!.external).toEqual({ repo: "https://github.com/acme/plat.git", commit: null, root: "deps/plat" });
  });

  it("codeowners skips external components and their contracts", () => {
    const root = fixture("external-workspace");
    const text = renderCodeowners(loadWorkspace(root), "acme");
    expect(text).not.toContain("deps/plat");
    const rules = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(rules).toContainEqual(["/products/degent/services/api/", "@acme/team-degent"]);
    expect(rules).toContainEqual(["/contracts/openapi/api.yaml", "@acme/team-degent"]);
    expect(rules.filter(([p]) => p!.includes("core"))).toEqual([]);
    runCodeowners(loadWorkspace(root), { org: "acme" });
    expect(readFileSync(path.join(root, CODEOWNERS_FILE), "utf8")).toBe(text);
    expect(runCodeowners(loadWorkspace(root), { check: true, org: "acme" }).diagnostics).toEqual([]);
  });
});
