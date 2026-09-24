/**
 * `readiness`: is this repository fit to be published as open source?
 *
 * Repo level: a LICENSE whose header is the Apache License 2.0, a NOTICE, the community files (SECURITY,
 * CONTRIBUTING, CODE_OF_CONDUCT, SUPPORT, GOVERNANCE, TRADEMARKS), GitHub issue forms and the security workflows.
 * Package level (every workspace package owned by this repository; external packages under a nested workspace
 * root are checked in their own repository): package.json `license` equals the repository's licence, a README.md
 * with a "Quickstart" heading and at least `minReadmeLines` non-blank lines, and a `lifecycle` in component.yaml.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckResult, Diagnostic } from "./types.js";
import { isRecord, MANIFEST_FILE, type Workspace, type WorkspacePackage } from "./workspace.js";

/** SPDX id every repository and package must carry (board decision: all our code is Apache-2.0). */
export const EXPECTED_LICENSE = "Apache-2.0";

/** Files that must exist at the repository root. */
export const REQUIRED_ROOT_FILES = [
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "TRADEMARKS.md",
] as const;

/** Supply-chain / security automation that must exist under .github/. */
export const REQUIRED_SECURITY_FILES = [
  ".github/workflows/security.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/dco.yml",
  ".github/workflows/scorecard.yml",
  ".github/dependabot.yml",
] as const;

export const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
export const DEFAULT_MIN_README_LINES = 20;

export interface ReadinessOptions {
  /** Minimum number of non-blank lines in a package README.md (default {@link DEFAULT_MIN_README_LINES}). */
  minReadmeLines?: number;
}

/** SPDX id of a licence text recognised from its header, or null. Only licences we may encounter are known. */
export function detectLicense(text: string): string | null {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines[0] === "Apache License" && lines[1] === "Version 2.0, January 2004") return "Apache-2.0";
  if (/^MIT License$/i.test(lines[0] ?? "")) return "MIT";
  return null;
}

/** Markdown with fenced code blocks removed, so a `# Quickstart` comment inside a bash block does not count. */
export function stripFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export const hasQuickstartHeading = (md: string): boolean => /^#{1,6}[ \t]+Quickstart\b/im.test(stripFences(md));
export const nonBlankLines = (md: string): number => md.split(/\r?\n/).filter((l) => l.trim().length > 0).length;

const isFile = (abs: string): boolean => existsSync(abs) && statSync(abs).isFile();

function checkRepo(root: string, diagnostics: Diagnostic[]): void {
  for (const f of REQUIRED_ROOT_FILES) {
    if (!isFile(path.join(root, f))) {
      diagnostics.push({ severity: "error", rule: "root-file-missing", file: f, message: `Repository root has no ${f}` });
    }
  }
  const licenseAbs = path.join(root, "LICENSE");
  if (isFile(licenseAbs)) {
    const spdx = detectLicense(readFileSync(licenseAbs, "utf8"));
    if (spdx !== EXPECTED_LICENSE) {
      diagnostics.push({
        severity: "error",
        rule: "license-header",
        file: "LICENSE",
        line: 1,
        message: `LICENSE must be the Apache License 2.0 text ("Apache License" / "Version 2.0, January 2004"); found ${spdx ?? "an unrecognised licence"}`,
      });
    }
  }

  const tplAbs = path.join(root, ISSUE_TEMPLATE_DIR);
  const forms = existsSync(tplAbs) && statSync(tplAbs).isDirectory() ? readdirSync(tplAbs).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (forms.filter((f) => !/^config\.ya?ml$/.test(f)).length === 0) {
    diagnostics.push({
      severity: "error",
      rule: "issue-templates-missing",
      file: ISSUE_TEMPLATE_DIR,
      message: `${ISSUE_TEMPLATE_DIR}/ has no issue forms (*.yml)`,
    });
  } else if (!forms.some((f) => /^config\.ya?ml$/.test(f))) {
    diagnostics.push({
      severity: "warning",
      rule: "issue-template-config-missing",
      file: `${ISSUE_TEMPLATE_DIR}/config.yml`,
      message: "No config.yml: security reports should be routed to private advisories, not public issues",
    });
  }

  for (const f of REQUIRED_SECURITY_FILES) {
    if (!isFile(path.join(root, f))) {
      diagnostics.push({ severity: "error", rule: "security-workflow-missing", file: f, message: `Missing ${f}` });
    }
  }
}

function checkPackage(pkg: WorkspacePackage, minReadmeLines: number, diagnostics: Diagnostic[]): void {
  const component = pkg.packageJson.name ?? pkg.dir;
  const license = pkg.packageJson.license;
  if (typeof license !== "string" || license.trim() === "") {
    diagnostics.push({
      severity: "error",
      rule: "package-license-missing",
      file: `${pkg.dir}/package.json`,
      component,
      message: `package.json has no "license"; expected "${EXPECTED_LICENSE}"`,
    });
  } else if (license !== EXPECTED_LICENSE) {
    diagnostics.push({
      severity: "error",
      rule: "package-license-mismatch",
      file: `${pkg.dir}/package.json`,
      component,
      message: `package.json "license" is "${license}"; the repository is "${EXPECTED_LICENSE}"`,
    });
  }

  const readmeRel = `${pkg.dir}/README.md`;
  const readmeAbs = path.join(pkg.absDir, "README.md");
  if (!isFile(readmeAbs)) {
    diagnostics.push({ severity: "error", rule: "readme-missing", file: readmeRel, component, message: "Package has no README.md" });
  } else {
    const md = readFileSync(readmeAbs, "utf8");
    if (!hasQuickstartHeading(md)) {
      diagnostics.push({
        severity: "error",
        rule: "readme-quickstart-missing",
        file: readmeRel,
        component,
        message: 'README.md has no "Quickstart" heading (e.g. "## Quickstart")',
      });
    }
    const n = nonBlankLines(md);
    if (n < minReadmeLines) {
      diagnostics.push({
        severity: "error",
        rule: "readme-too-short",
        file: readmeRel,
        component,
        message: `README.md has ${n} non-blank line(s); at least ${minReadmeLines} required`,
      });
    }
  }

  // A missing or unparseable manifest is `validate`'s finding; here only the lifecycle matters.
  if (pkg.manifestPath && isRecord(pkg.manifest)) {
    const lc = pkg.manifest.lifecycle;
    if (typeof lc !== "string" || lc.trim() === "") {
      diagnostics.push({
        severity: "error",
        rule: "lifecycle-missing",
        file: pkg.manifestPath,
        line: 1,
        component,
        message: `${MANIFEST_FILE} has no lifecycle (experimental | beta | production | deprecated)`,
      });
    }
  } else if (!pkg.manifestPath) {
    diagnostics.push({
      severity: "error",
      rule: "lifecycle-missing",
      file: `${pkg.dir}/${MANIFEST_FILE}`,
      component,
      message: `No ${MANIFEST_FILE}, so no lifecycle`,
    });
  }
}

export function checkReadiness(ws: Workspace, opts: ReadinessOptions = {}): CheckResult {
  const minReadmeLines = opts.minReadmeLines ?? DEFAULT_MIN_README_LINES;
  const diagnostics: Diagnostic[] = [];
  checkRepo(ws.root, diagnostics);
  const own = ws.packages.filter((p) => !p.external);
  for (const pkg of own) checkPackage(pkg, minReadmeLines, diagnostics);
  return {
    command: "readiness",
    diagnostics,
    stats: {
      packages: own.length,
      external: ws.packages.length - own.length,
    },
  };
}
