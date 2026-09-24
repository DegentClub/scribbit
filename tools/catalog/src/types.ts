/** Shared types for the catalog tool. Every check reports `Diagnostic`s; nothing throws on user error. */

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Stable, machine-matchable rule id (kebab-case). Documented in tools/catalog/README.md. */
  rule: string;
  /** Repo-relative POSIX path of the file the problem is in. */
  file: string;
  /** 1-based line, when known. */
  line?: number;
  /** Component name (or package name when the manifest is unusable). */
  component?: string;
  /** `external` when the finding concerns a package under a nested workspace root (another repository). */
  group?: "external";
  message: string;
}

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  /** SPDX licence expression. */
  license?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The shape of component.yaml (see schemas/component.schema.json). Only trusted after validation. */
export interface Manifest {
  name: string;
  package: string;
  kind: "library" | "service" | "app" | "indexer" | "job" | "tool";
  product: Product;
  owner: string;
  summary: string;
  lifecycle: "experimental" | "beta" | "production" | "deprecated";
  depends_on?: string[];
  provides?: string[];
  consumes?: string[];
  stores?: string[];
  secrets?: string[];
  env_schema?: string;
  slo?: { availability?: string; p95_ms?: number };
  runbook?: string;
  docs?: string;
  commands?: Record<string, string>;
  [extra: string]: unknown;
}

export type Product = "platform" | "blockspace" | "scribbit" | "degent" | "tooling";

/** Product slugs that are *products* (may not import each other). `platform` and `tooling` are shared. */
export const PRODUCT_SLUGS: ReadonlySet<string> = new Set(["blockspace", "scribbit", "degent"]);

export interface CheckResult {
  command: string;
  diagnostics: Diagnostic[];
  /** Command-specific counters for the summary line / JSON output. */
  stats: Record<string, number>;
}
