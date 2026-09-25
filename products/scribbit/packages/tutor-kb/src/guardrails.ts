/**
 * Product-policy guardrails, owned here so the HTTP service and the MCP tool enforce the identical rules
 * (see POLICY.md). Two families:
 *   - refusals: price/investment, key material, mainnet signing — the tutor must refuse these.
 *   - sanitisation: prompt-injection markers are stripped from untrusted text (user question AND retrieved
 *     KB), which is always treated as data, never instructions.
 * Everything is pure and regex-based (no model), so every rule is directly unit-testable.
 */

/** Stable machine reason for a refusal. Agents branch on these. */
export type RefusalReason = 'price_advice' | 'key_material' | 'mainnet_signing';

export interface Refusal {
  refused: true;
  reason: RefusalReason;
  /** Human-facing explanation + redirect. Safe to show verbatim. */
  message: string;
}

const PRICE_PATTERNS: RegExp[] = [
  /\bprice\s*(prediction|target|forecast)\b/,
  /\b(should|shall|do|would|can)\s+(i|we|you)\s+(buy|sell|invest|hodl|hold|ape|stack)\b/,
  /\b(is|are|was)\s+.*\b(a\s+)?(good|bad|smart|worth(while)?)\s+(buy|investment|to\s+buy)\b/,
  /\b(worth\s+(buying|investing|it)|good\s+investment|investment\s+advice)\b/,
  /\b(when|will)\b.*\b(moon|lambo|pump|dump|ath|all[-\s]?time\s+high|go\s+up|go\s+down|crash|rally)\b/,
  /\b(bull|bear)\s+(market|run)\b|\bprice\s+of\s+(bitcoin|btc|ord|rune|sats?)\b/,
  /\b(how\s+much\s+(is|are|will).*\bworth\b|what('| i)?s?\s+.*\bworth\b.*\?)/,
  /\b(roi|return\s+on\s+investment|profit|make\s+money|get\s+rich|portfolio\s+allocat)/,
  /\b(buy|sell|trade|trading|invest(ing|ment)?)\s+(bitcoin|btc|ordinals?|runes?|inscriptions?|sats?)\b/,
];

const KEY_PATTERNS: RegExp[] = [
  /\b(seed\s*phrase|recovery\s*phrase|mnemonic|secret\s*phrase|12[-\s]word|24[-\s]word)\b/,
  /\bprivate\s*key(s)?\b/,
  /\b(xprv|tprv|wif)\b/,
  /\b(reveal|show|give|send|share|tell|store|save|keep|hold|generate|create|make)\b.*\b(seed|mnemonic|private\s*key|recovery\s*phrase|secret\s*key)\b/,
  /\b(here('| i)?s|this\s+is|my)\s+(seed|mnemonic|private\s*key|recovery\s*phrase)\b/,
  /\bimport\s+(my\s+)?(seed|wallet|private\s*key)\b/,
];

const MAINNET_SIGN_PATTERNS: RegExp[] = [
  /\b(sign|broadcast|send|submit|finali[sz]e|relay)\b.*\bmainnet\b/,
  /\bmainnet\b.*\b(sign|broadcast|send|submit|finali[sz]e|relay)\b/,
  /\b(sign|broadcast)\b.*\b(real|live)\s+(bitcoin|btc|transaction|tx)\b/,
  /\bspend\s+(my\s+)?(real\s+)?(bitcoin|btc|coins?|sats?)\b.*\b(for\s+me|on\s+my\s+behalf)\b/,
];

/** Prompt-injection markers to neutralise in untrusted text. Matching text is annotated, not obeyed. */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|messages?)\b/gi,
  /\bdisregard\s+(all\s+)?(previous|prior|above|the)\s+(instructions?|rules?|guardrails?)\b/gi,
  /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+(to\s+be|you\s+are)\b|\bnew\s+(system\s+)?(prompt|instructions?)\b/gi,
  /\b(system|developer)\s*(prompt|message|role)\s*[:=]/gi,
  /\boverride\s+(your\s+)?(instructions?|guardrails?|rules?|safety)\b/gi,
  /\b(reveal|print|repeat|show)\s+(your\s+)?(system\s+prompt|instructions?|hidden\s+prompt)\b/gi,
  /<\/?(system|assistant|instructions?)>/gi,
];

const learnRedirect =
  'I can explain how blockspace and Bitcoin work — how fees, weight, inscriptions and the mempool behave — ' +
  'but not what anything is worth or whether to buy, sell or hold it. Try asking how the mechanism works, ' +
  'e.g. "how is a fee rate calculated?" or "how big can an inscription be?"';

/** Classify a question against the refusal policies. Returns a `Refusal` or `null` (allowed). Order matters: key material first (most serious). */
export function classifyRefusal(question: string): Refusal | null {
  const q = question.toLowerCase();
  if (KEY_PATTERNS.some((re) => re.test(q))) {
    return {
      refused: true,
      reason: 'key_material',
      message:
        'Stop — never share, type or store a seed phrase, recovery phrase or private key here, or anywhere online. ' +
        'This service is non-custodial: it never asks for, accepts or generates your keys, and no legitimate ' +
        'scribb.it flow ever will. Keys stay in your own wallet on your own device. If anyone or anything asked ' +
        'you for your seed, treat it as a scam. I can explain how keys, PSBTs and non-custodial signing work instead.',
    };
  }
  if (MAINNET_SIGN_PATTERNS.some((re) => re.test(q))) {
    return {
      refused: true,
      reason: 'mainnet_signing',
      message:
        'I can\'t sign or broadcast a mainnet transaction for you — this service holds no keys and spends no one\'s ' +
        'coins. Signing happens in your own wallet. I can explain the non-custodial commit/reveal flow, or point you ' +
        'to the Signet Playground where you can practise the whole thing safely with valueless signet coins.',
    };
  }
  if (PRICE_PATTERNS.some((re) => re.test(q))) {
    return { refused: true, reason: 'price_advice', message: learnRedirect };
  }
  return null;
}

export interface Sanitized {
  text: string;
  /** True if any injection marker was found and neutralised. */
  injectionDetected: boolean;
  /** The markers that were neutralised (for logging / transparency). */
  markers: string[];
}

/** Neutralise prompt-injection markers in untrusted text. The text is kept (as data) with markers redacted. */
export function sanitize(text: string): Sanitized {
  const markers: string[] = [];
  let out = text;
  for (const re of INJECTION_PATTERNS) {
    out = out.replace(re, (m) => {
      markers.push(m.trim());
      return '[redacted-instruction]';
    });
  }
  return { text: out, injectionDetected: markers.length > 0, markers };
}

export { learnRedirect };
