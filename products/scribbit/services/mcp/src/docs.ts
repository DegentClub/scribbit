/**
 * `scribbit://docs/security-model`: the "Security model" section of @bsh/inscription's README, read from the
 * installed package so the resource never drifts from the library it describes. Resolved through the
 * package's entry point (the workspace links source, so README.md sits next to src/).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export const FALLBACK_SECURITY_MODEL = `# @bsh/inscription security model (summary)

Two sighash modes, both SIGHASH_ANYONECANPAY on the commit input so the service can add the parent input later.

**0x81 (SIGHASH_ALL | ANYONECANPAY, the default since ADR-0005).** The half-signed reveal is
[commit] -> [parent return, child]: the signature covers the commit outpoint, amount and script, the inscription
tapleaf and EVERY output. Nobody holding the PSBT can add an output, change output 0, swap outputs or drop the
parent return, so the 0x83 fee-skimming and re-targeting vectors are closed by construction. The service may only
insert the parent input (and refuses one whose value differs from output 0). Because output 0 is unfunded without
the parent, the half-signed PSBT is NOT broadcastable on its own: self-rescue is a fresh transaction, re-signed
with the ephemeral key K_e (buildResignedRescue: [commit] -> [child], SIGHASH_DEFAULT). Keep K_e, the content, the
commit outpoint and value, the recipient and the postage in the recovery bundle; the rescue lands without on-chain
parent provenance, and whichever of reveal / rescue confirms first wins.

**0x83 (SIGHASH_SINGLE | ANYONECANPAY, legacy).** The signature covers the commit input and only the output at its
own index, so the same signature validates with and without the parent and the half-signed PSBT itself is the
rescue transaction (buildRescueReveal; the rescue_tx tool). Known limitation: whoever holds it can add outputs at
index >= 2 (fee skimming) or put their own input at index 0 with a mismatched output 0 (inscription re-targeting).
If you still use 0x83, keep the PSBT confidential until broadcast and broadcast promptly.`;

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
    return { text: FALLBACK_SECURITY_MODEL, source: 'embedded-summary' as const };
  })();
  return cached;
}
