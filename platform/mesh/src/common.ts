// Shared vocabulary for every validator in this package: a Finding with a stable
// code and a path, plus the id/date regexes the FlashyOS checkers share
// (check-directory.mjs, vendor-backlog.mjs, vendor-shiplog.mjs).

export type Severity = 'error' | 'warning';

/** One problem a validator found. `code` is stable (tests and CI match on it); `path` says where. */
export interface Finding {
  code: string;
  path: string;
  message: string;
  severity: Severity;
}

export const finding = (code: string, path: string, message: string, severity: Severity = 'error'): Finding => ({
  code,
  path,
  message,
  severity,
});

export const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.severity === 'error');
export const hasErrors = (findings: readonly Finding[]): boolean => findings.some((f) => f.severity === 'error');

/** A findings accumulator with the two verbs the vendored checkers use. */
export class Collector {
  readonly findings: Finding[] = [];
  bad(code: string, path: string, message: string): void {
    this.findings.push(finding(code, path, message, 'error'));
  }
  warn(code: string, path: string, message: string): void {
    this.findings.push(finding(code, path, message, 'warning'));
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `prefix/slug` - the id shape every directory node, agent and person carries. */
export const NODE_ID_RE = /^[a-z]+\/[a-z0-9][a-z0-9._-]*$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const REPO_ID_RE = /^repo\/[a-z0-9][a-z0-9._-]*$/;
export const ORG_ID_RE = /^org\/[a-z0-9][a-z0-9._-]*$/;

export const VISIBILITIES = ['public', 'partner', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const isVisibility = (v: unknown): v is Visibility => typeof v === 'string' && (VISIBILITIES as readonly string[]).includes(v);

export const isIsoDateTime = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !Number.isNaN(Date.parse(s));
