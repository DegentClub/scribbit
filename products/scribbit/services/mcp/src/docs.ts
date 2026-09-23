/**
 * `scribbit://docs/security-model`: the "Security model" section of @bsh/inscription's README, read from the
 * installed package so the resource never drifts from the library it describes. Resolved through the
 * package's entry point (the workspace links source, so README.md sits next to src/).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const FALLBACK = `# @bsh/inscription security model (summary)

The reveal's commit input is signed with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY (0x83): the signature covers
the commit outpoint, amount and script, the child output (recipient + postage) and the inscription tapleaf,
and nothing else. A service can therefore insert a parent input and parent-return output at index 0 without
touching the signature, and the half-signed PSBT is itself the self-rescue transaction (no parent).

Known limitation of 0x83: whoever holds the half-signed PSBT can add outputs at index >= 2 (fee skimming) or
put their own input at index 0 with a mismatched output 0 (inscription re-targeting). Keep the PSBT
confidential until broadcast, and broadcast promptly.`;

export interface SecurityModelDoc {
  text: string;
  source: 'inscription-readme' | 'embedded-summary';
}

let cached: Promise<SecurityModelDoc> | undefined;

export function inscriptionReadmePath(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('@bsh/inscription');
    // entry is <pkg>/src/index.ts in the workspace (no build step); README.md sits at the package root.
    let dir = path.dirname(entry);
    for (let i = 0; i < 3; i++) {
      const candidate = path.join(dir, 'README.md');
      if (candidate.endsWith(path.join('inscription', 'README.md'))) return candidate;
      dir = path.dirname(dir);
    }
    return path.join(path.dirname(path.dirname(entry)), 'README.md');
  } catch {
    return undefined;
  }
}

/** Extract `## Security model` up to the next `## ` heading. */
export function extractSecuritySection(readme: string): string | undefined {
  const m = /^## Security model\s*$/m.exec(readme);
  if (!m) return undefined;
  const rest = readme.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return `# @bsh/inscription security model\n\n${body}\n`;
}

export function securityModelDoc(): Promise<SecurityModelDoc> {
  cached ??= (async () => {
    const p = inscriptionReadmePath();
    if (p) {
      try {
        const section = extractSecuritySection(await readFile(p, 'utf8'));
        if (section) return { text: section, source: 'inscription-readme' as const };
      } catch {
        /* fall through */
      }
    }
    return { text: FALLBACK, source: 'embedded-summary' as const };
  })();
  return cached;
}
