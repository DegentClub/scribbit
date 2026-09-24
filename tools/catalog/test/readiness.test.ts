import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import {
  checkReadiness,
  detectLicense,
  hasQuickstartHeading,
  ISSUE_TEMPLATE_DIR,
  REQUIRED_ROOT_FILES,
  REQUIRED_SECURITY_FILES,
} from "../src/readiness.js";
import { loadWorkspace } from "../src/workspace.js";
import { errorsOf, fixture, rules } from "./helpers.js";

const APACHE_HEADER = "\n                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n";

/** The `readiness` fixture plus every repo-level file, so only package findings remain. */
function readyRepo(): string {
  const dir = fixture("readiness");
  for (const f of REQUIRED_ROOT_FILES) writeFileSync(path.join(dir, f), f === "LICENSE" ? APACHE_HEADER : `# ${f}\n`);
  for (const f of [...REQUIRED_SECURITY_FILES, `${ISSUE_TEMPLATE_DIR}/bug.yml`, `${ISSUE_TEMPLATE_DIR}/config.yml`]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "name: fixture\n");
  }
  return dir;
}

describe("readiness", () => {
  it("recognises licences by their header", () => {
    expect(detectLicense(APACHE_HEADER)).toBe("Apache-2.0");
    expect(detectLicense("﻿Apache License\r\n\r\nVersion 2.0, January 2004\r\n")).toBe("Apache-2.0");
    expect(detectLicense("MIT License\n\nCopyright (c) 2026\n")).toBe("MIT");
    expect(detectLicense("Apache License\nVersion 1.1\n")).toBeNull();
    expect(detectLicense("")).toBeNull();
  });

  it("finds a Quickstart heading outside code fences only", () => {
    expect(hasQuickstartHeading("# x\n\n## Quickstart\n")).toBe(true);
    expect(hasQuickstartHeading("### Quickstart (browser)\n")).toBe(true);
    expect(hasQuickstartHeading("```bash\n# Quickstart\n```\n")).toBe(false);
    expect(hasQuickstartHeading("~~~\n## Quickstart\n~~~\n")).toBe(false);
    expect(hasQuickstartHeading("Quickstart\n\n## Quick start\n")).toBe(false);
  });

  it("checks every package this repository owns and skips external ones", () => {
    const res = checkReadiness(loadWorkspace(readyRepo()));
    expect(res.stats).toEqual({ packages: 4, external: 1 });
    expect(res.diagnostics.every((d) => d.component !== "@bsh/ext" && !d.file.startsWith("deps/"))).toBe(true);
    expect(res.diagnostics.filter((d) => d.component === "@bsh/core")).toEqual([]);
    expect(rules(res.diagnostics)).toEqual([
      "lifecycle-missing",
      "package-license-mismatch",
      "package-license-missing",
      "readme-missing",
      "readme-quickstart-missing",
      "readme-too-short",
    ]);
    const by = (c: string) => res.diagnostics.filter((d) => d.component === c).map((d) => d.rule).sort();
    expect(by("@bsh/nolicense")).toEqual(["lifecycle-missing", "package-license-missing", "readme-quickstart-missing", "readme-too-short"]);
    expect(by("@bsh/fenced")).toEqual(["package-license-mismatch", "readme-quickstart-missing"]);
    expect(by("@bsh/nomanifest")).toEqual(["lifecycle-missing", "readme-missing"]);
    expect(errorsOf(res.diagnostics, "readme-too-short")[0]).toMatchObject({
      file: "products/scribbit/packages/nolicense/README.md",
      message: "README.md has 2 non-blank line(s); at least 20 required",
    });
  });

  it("honours --min-readme-lines", () => {
    const res = checkReadiness(loadWorkspace(readyRepo()), { minReadmeLines: 2 });
    expect(errorsOf(res.diagnostics, "readme-too-short")).toEqual([]);
    const strict = checkReadiness(loadWorkspace(readyRepo()), { minReadmeLines: 200 });
    expect(errorsOf(strict.diagnostics, "readme-too-short").map((d) => d.component).sort()).toEqual(["@bsh/core", "@bsh/fenced", "@bsh/nolicense"]);
  });

  it("reports missing repo-level files, issue forms and security workflows", () => {
    const res = checkReadiness(loadWorkspace(fixture("readiness")));
    const missing = errorsOf(res.diagnostics, "root-file-missing").map((d) => d.file);
    expect(missing).toEqual([...REQUIRED_ROOT_FILES]);
    expect(errorsOf(res.diagnostics, "security-workflow-missing").map((d) => d.file)).toEqual([...REQUIRED_SECURITY_FILES]);
    expect(errorsOf(res.diagnostics, "issue-templates-missing")).toHaveLength(1);
    expect(errorsOf(res.diagnostics, "license-header")).toEqual([]); // no LICENSE: reported once, as missing
  });

  it("rejects a LICENSE that is not Apache-2.0 and warns when issue forms lack config.yml", () => {
    const dir = readyRepo();
    writeFileSync(path.join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026\n");
    rmSync(path.join(dir, ISSUE_TEMPLATE_DIR, "config.yml"));
    const res = checkReadiness(loadWorkspace(dir));
    expect(errorsOf(res.diagnostics, "license-header")[0]).toMatchObject({ severity: "error", file: "LICENSE", line: 1 });
    expect(errorsOf(res.diagnostics, "license-header")[0]?.message).toContain("found MIT");
    expect(errorsOf(res.diagnostics, "issue-template-config-missing")[0]?.severity).toBe("warning");

    rmSync(path.join(dir, ISSUE_TEMPLATE_DIR, "bug.yml"));
    writeFileSync(path.join(dir, ISSUE_TEMPLATE_DIR, "config.yml"), "blank_issues_enabled: false\n");
    const onlyConfig = checkReadiness(loadWorkspace(dir));
    expect(errorsOf(onlyConfig.diagnostics, "issue-templates-missing")).toHaveLength(1);
  });

  it("parses --min-readme-lines", () => {
    expect(parseArgs(["readiness", "--min-readme-lines", "30"])).toEqual({ command: "readiness", json: false, check: false, minReadmeLines: 30 });
    expect(parseArgs(["readiness", "--min-readme-lines", "x"])).toContain("non-negative integer");
    expect(parseArgs(["readiness", "--min-readme-lines"])).toContain("non-negative integer");
  });

  it("exits 1 with JSON diagnostics on findings and 0 when ready", () => {
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cli = (args: string[]) =>
      spawnSync(path.join(pkgDir, "node_modules/.bin/tsx"), [path.join(pkgDir, "src/cli.ts"), ...args], { encoding: "utf8" });

    const dir = readyRepo();
    const bad = cli(["readiness", "--json", "--root", dir]);
    expect(bad.status).toBe(1);
    const out = JSON.parse(bad.stdout) as { command: string; ok: boolean; stats: Record<string, number>; diagnostics: { rule: string }[] };
    expect(out).toMatchObject({ command: "readiness", ok: false, stats: { packages: 4, external: 1 } });
    expect(out.diagnostics.map((d) => d.rule)).toContain("readme-quickstart-missing");

    // Keep only the compliant package: the repo is then ready.
    for (const p of ["products/scribbit/packages/nolicense", "products/scribbit/packages/fenced", "products/scribbit/services/nomanifest"]) {
      rmSync(path.join(dir, p), { recursive: true });
    }
    const good = cli(["readiness", "--json", "--root", dir]);
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ ok: true, counts: { errors: 0, warnings: 0 }, diagnostics: [] });
  }, 30_000);
});
