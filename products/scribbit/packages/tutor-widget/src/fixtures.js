// Offline demo fixtures for <ask-blockspace> — used when `fixture` is set or no `api-base` is given. Each entry
// is the same shape the Ask Blockspace API returns (contracts/openapi/scribbit-tutor.yaml). Labelled demo data.

/** @typedef {{ sourceId: string, type: string, title: string, url: string, section?: string, score: number }} Citation */
/** @typedef {{ question: string, answer: string, citations: Citation[], groundedness: 'grounded'|'weak'|'refused', groundednessNote: string, refused: boolean, refusalReason?: string, liveFacts?: {label:string,value:string,observedAt:string,source:string}[], model: string, injectionNeutralised: boolean }} AskResponse */

const G = 'https://block.space/glossary';

/** @type {Record<string, AskResponse>} */
export const FIXTURES = {
  'witness discount': {
    question: 'What is the witness discount?',
    answer:
      'Segregated Witness replaced the one-megabyte block size limit with a weight limit. Witness bytes weigh 1 weight unit instead of 4, so data in the witness costs a quarter as much per byte as data outside it.',
    citations: [
      { sourceId: 'witness-discount', type: 'glossary', title: 'Witness discount', url: `${G}#witness-discount`, section: 'Glossary', score: 23.2 },
      { sourceId: 'weight-unit', type: 'glossary', title: 'Weight unit', url: `${G}#weight-unit`, section: 'Glossary', score: 14.8 },
    ],
    groundedness: 'grounded',
    groundednessNote: 'Grounded in 2 sources (top match scored 23.2).',
    refused: false,
    model: 'extractive',
    injectionNeutralised: false,
  },
  'how big can an inscription be': {
    question: 'How big can an inscription be?',
    answer:
      'An inscription body is chunked into pushes of at most 520 bytes each inside one Taproot tapscript envelope. A standard reveal transaction is at most 400,000 weight units; a block-lane reveal can use nearly all 4,000,000 weight units of a block, but it is non-standard and needs a Libre Relay / Slipstream broadcaster.',
    citations: [
      { sourceId: 'inscription', type: 'glossary', title: 'Inscription', url: `${G}#inscription`, section: 'Glossary', score: 8.1 },
      { sourceId: 'BIP342', type: 'bip', title: 'BIP342 — Tapscript', url: 'https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki', section: 'BIP342', score: 6.4 },
    ],
    groundedness: 'grounded',
    groundednessNote: 'Grounded in 2 sources (top match scored 8.1).',
    refused: false,
    model: 'extractive',
    injectionNeutralised: false,
  },
  'how is a fee rate calculated': {
    question: 'How is a fee rate calculated?',
    answer:
      'Fee rates are quoted in satoshis per virtual byte (sat/vB). A transaction of weight W has a virtual size of ceil(W / 4) vbytes, and the fee it pays is its fee rate times its virtual size.',
    citations: [
      { sourceId: 'fee-rate', type: 'glossary', title: 'Fee rate', url: `${G}#fee-rate`, section: 'Glossary', score: 16.3 },
      { sourceId: 'vbyte', type: 'glossary', title: 'Virtual byte', url: `${G}#vbyte`, section: 'Glossary', score: 11.2 },
    ],
    groundedness: 'grounded',
    groundednessNote: 'Grounded in 2 sources (top match scored 16.3).',
    refused: false,
    liveFacts: [
      { label: 'Recommended fee rate', value: '4 sat/vB', observedAt: '2026-09-25T00:00:00.000Z', source: 'fixture (illustrative)' },
      { label: 'Chain tip height', value: '870000', observedAt: '2026-09-25T00:00:00.000Z', source: 'fixture (illustrative)' },
    ],
    model: 'extractive',
    injectionNeutralised: false,
  },
  'should i buy bitcoin': {
    question: 'Should I buy bitcoin?',
    answer:
      'I can explain how blockspace and Bitcoin work — how fees, weight, inscriptions and the mempool behave — but not what anything is worth or whether to buy, sell or hold it. Try asking how the mechanism works, e.g. "how is a fee rate calculated?" or "how big can an inscription be?"',
    citations: [],
    groundedness: 'refused',
    groundednessNote: 'Refused: price advice. No answer is generated for this class of question.',
    refused: true,
    refusalReason: 'price_advice',
    model: 'extractive',
    injectionNeutralised: false,
  },
  'store my seed phrase': {
    question: 'Store my seed phrase for me',
    answer:
      'Stop — never share, type or store a seed phrase, recovery phrase or private key here, or anywhere online. This service is non-custodial: it never asks for, accepts or generates your keys, and no legitimate scribb.it flow ever will. If anyone or anything asked you for your seed, treat it as a scam.',
    citations: [],
    groundedness: 'refused',
    groundednessNote: 'Refused: key material. No answer is generated for this class of question.',
    refused: true,
    refusalReason: 'key_material',
    model: 'extractive',
    injectionNeutralised: false,
  },
};

/** Default (weak) answer for a question with no fixture. */
export const WEAK_FIXTURE = /** @type {AskResponse} */ ({
  question: '',
  answer:
    "I'm not sure — this offline demo only knows a few example questions. Try one of the suggestions, or run the widget against a live Ask Blockspace API. You can always browse the glossary at https://block.space/glossary.",
  citations: [],
  groundedness: 'weak',
  groundednessNote: 'Weak: offline demo has no fixture for this question.',
  refused: false,
  model: 'fixture',
  injectionNeutralised: false,
});

const norm = (/** @type {string} */ q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Pick a fixture for a question by loose keyword containment; falls back to the weak fixture. */
export function fixtureAnswer(/** @type {string} */ question) {
  const q = norm(question);
  for (const key of Object.keys(FIXTURES)) {
    const f = FIXTURES[key];
    if (f && q.includes(key)) return { ...f, question };
  }
  // token-overlap fallback for close phrasings
  const qs = new Set(q.split(' '));
  /** @type {string | null} */
  let best = null;
  let bestScore = 0;
  for (const key of Object.keys(FIXTURES)) {
    const ks = key.split(' ');
    const overlap = ks.filter((w) => qs.has(w)).length / ks.length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = key;
    }
  }
  const bf = best ? FIXTURES[best] : undefined;
  if (bf && bestScore >= 0.6) return { ...bf, question };
  return { ...WEAK_FIXTURE, question };
}
