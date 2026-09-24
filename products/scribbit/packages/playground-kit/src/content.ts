/**
 * The words of the Signet Playground: one source for the app's explanation panels and "what just happened on
 * chain" cards, and for the MCP tool `playground_explain_step`. Plain language first; every Bitcoin number here is
 * a protocol fact (see the facts list in ADR-0009), never a price.
 */

export const PLAYGROUND_VERSION = '1';
/** The learning goal: a first inscription on signet, from nothing, in under five minutes. */
export const GOAL_SECONDS = 300;
/** Default file limit: small enough to be cheap in test coins and quick to relay. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024;

export type StepId = 'wallet' | 'coins' | 'file' | 'inscribe' | 'certificate';
export const STEP_IDS: readonly StepId[] = ['wallet', 'coins', 'file', 'inscribe', 'certificate'];

export interface GlossaryEntry {
  /** Stable id, used as an anchor (`#term-<id>`). */
  id: string;
  term: string;
  definition: string;
}

export interface StepContent {
  id: StepId;
  /** 1-based position in the flow. */
  number: number;
  title: string;
  /** One line under the heading. */
  summary: string;
  /** The explanation panel: two to four short paragraphs. */
  explanation: string[];
  /** What the "what just happened on chain" card says about this step (before any data fills it). */
  onChain: string;
  /** Glossary ids relevant to this step. */
  glossary: string[];
  /** A safety line shown with the step, when there is one. */
  safety?: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { id: 'signet', term: 'Signet', definition: 'A public Bitcoin test network. It runs the same software rules as Bitcoin, but its blocks must be signed by a designated key holder, so blocks arrive steadily and its coins have no value. Mistakes here cost nothing.' },
  { id: 'mainnet', term: 'Mainnet', definition: 'The real Bitcoin network, where coins have value. Signet addresses start with tb1; mainnet addresses start with bc1. Never send real bitcoin to a signet address.' },
  { id: 'sats', term: 'sats', definition: 'Satoshis, the smallest unit of bitcoin: 1 bitcoin is 100,000,000 sats. Signet sats are test units with no value.' },
  { id: 'private-key', term: 'Private key', definition: 'A secret 256-bit number. Whoever knows it can spend the coins at the matching address. It never needs to leave the device that signs.' },
  { id: 'address', term: 'Address', definition: 'A short text encoding of the rule that locks coins. A Taproot address (tb1p… on signet) is derived from a public key.' },
  { id: 'taproot', term: 'Taproot', definition: 'The newest standard output type (BIP 341). It can be spent with a single key signature or by revealing a script, which is how inscriptions carry data.' },
  { id: 'utxo', term: 'UTXO', definition: 'Unspent transaction output: a coin. Your balance is the sum of the UTXOs locked to your address; a transaction spends whole UTXOs and makes new ones.' },
  { id: 'faucet', term: 'Faucet', definition: 'A service that gives out small amounts of test coins. The playground faucet asks your browser for a short proof of work instead of a captcha.' },
  { id: 'proof-of-work', term: 'Proof of work', definition: 'Work that is expensive to do and cheap to check. Here your browser searches for a number whose SHA-256 hash starts with enough zero bits; the faucet checks it with one hash.' },
  { id: 'transaction', term: 'Transaction', definition: 'A signed message that spends UTXOs and creates new ones. Its id (txid) is a hash of its non-witness bytes.' },
  { id: 'txid', term: 'txid', definition: 'Transaction id: the double SHA-256 of a transaction without its witness data, shown in reverse byte order. Explorers look transactions up by it.' },
  { id: 'mempool', term: 'Mempool', definition: 'The waiting room of transactions that nodes have accepted but that are not in a block yet.' },
  { id: 'confirmation', term: 'Confirmation', definition: 'A transaction is confirmed once a block includes it. Signet aims for a block about every ten minutes, so the playground works with unconfirmed transactions and tells you when they confirm.' },
  { id: 'weight', term: 'Weight (WU)', definition: 'How much block space a transaction uses. Each non-witness byte costs 4 weight units, each witness byte 1. A block holds at most 4,000,000 WU; a standard transaction at most 400,000 WU.' },
  { id: 'vsize', term: 'Virtual size (vB)', definition: 'Weight divided by 4, rounded up. Fees are quoted per virtual byte (sat/vB).' },
  { id: 'fee-rate', term: 'Fee rate', definition: 'Sats paid per virtual byte. Fee = fee rate × vsize. Miners pick higher fee rates first.' },
  { id: 'witness', term: 'Witness', definition: 'The part of a SegWit or Taproot transaction that carries signatures and scripts. Witness bytes are discounted (1 WU per byte), which is why inscriptions live there.' },
  { id: 'inscription', term: 'Inscription', definition: 'A file written into a Bitcoin transaction witness using the ord envelope, and assigned to a satoshi by the Ordinals numbering scheme. Its id is <reveal txid>i<index>.' },
  { id: 'envelope', term: 'Envelope', definition: 'The script that holds the file: OP_FALSE OP_IF "ord" <content type> <body in chunks of at most 520 bytes> OP_ENDIF. OP_FALSE OP_IF means the data is never executed, only stored.' },
  { id: 'commit', term: 'Commit transaction', definition: 'The first of two transactions. It sends coins to a Taproot address that commits to the envelope script, without showing the script yet.' },
  { id: 'reveal', term: 'Reveal transaction', definition: 'The second transaction. It spends the commit output by revealing the envelope script in its witness, which puts the file on chain.' },
  { id: 'psbt', term: 'PSBT', definition: 'Partially Signed Bitcoin Transaction (BIP 174): an unsigned transaction plus the facts a signer needs, passed to a wallet to sign.' },
  { id: 'postage', term: 'Postage', definition: 'The sats in the output that carries the inscription (546 by default here). The Taproot dust limit is 330 sats.' },
  { id: 'lane', term: 'Lane', definition: 'Which relay path a reveal needs: the standard lane for transactions up to 400,000 WU, the block lane above that (it needs a miner that accepts non-standard transactions).' },
  { id: 'explorer', term: 'Block explorer', definition: 'A website that shows transactions, addresses and blocks. On signet you can look up everything you did in this playground.' },
  { id: 'inscription-id', term: 'Inscription id', definition: 'The reveal txid followed by i and the inscription index within that transaction, for example …i0.' },
];

export const STEPS: readonly StepContent[] = [
  {
    id: 'wallet',
    number: 1,
    title: 'Get a test wallet',
    summary: 'A key that can sign on signet: made in this tab, or your own wallet switched to signet.',
    explanation: [
      'A Bitcoin wallet is a private key and the addresses derived from it. To write anything on chain you need coins, and to spend coins you need a key that can sign.',
      'The quickest way here is a throwaway key made by your browser. It lives only in this tab (sessionStorage) and disappears when you close it. It never leaves your device and nobody else ever sees it.',
      'You can also connect a real wallet extension switched to signet. Some wallets are only assumed to work on signet: the playground shows which ones have not been verified.',
    ],
    onChain: 'Nothing yet. Making a key is pure maths on your device; the network does not know your address exists until coins are sent to it.',
    glossary: ['signet', 'private-key', 'address', 'taproot', 'mainnet'],
    safety: 'TEST NETWORK: never send real bitcoin to this address. A tb1 address is not a bc1 address.',
  },
  {
    id: 'coins',
    number: 2,
    title: 'Get free test coins',
    summary: 'Your browser does a moment of proof of work; the faucet sends a small amount of signet sats.',
    explanation: [
      'Signet coins are free because they are worthless: they exist only so people can practise. A faucet hands them out in small amounts.',
      'To stop one person draining the faucet, your browser first solves a small puzzle: find a number whose SHA-256 hash starts with enough zero bits. It takes your computer a few seconds and the faucet one hash to check. No captcha, no tracking.',
      'The faucet then sends a transaction to your address. It is valid as soon as nodes accept it into the mempool, so you can spend it straight away, before it is in a block.',
    ],
    onChain: 'The faucet broadcast a transaction with an output locked to your address. That output is a UTXO: your first coin.',
    glossary: ['faucet', 'proof-of-work', 'sats', 'utxo', 'transaction', 'mempool', 'txid'],
  },
  {
    id: 'file',
    number: 3,
    title: 'Pick a small file',
    summary: 'Choose a file (50 KB or less) or a sample, and see the exact cost before anything is signed.',
    explanation: [
      'An inscription stores the exact bytes of a file in a transaction witness. Space in a block is measured in weight: witness bytes cost 1 weight unit each, other bytes 4.',
      'The quote is computed by the same code that builds the transaction, so the weight is exact, not an estimate: weight, virtual size (weight ÷ 4, rounded up), the fee at the current signet fee rate, the postage that travels with the inscription, and the lane.',
      'Small files keep the playground fast and cheap in test coins. Up to 400,000 WU a reveal is standard and any node relays it.',
    ],
    onChain: 'Nothing on chain: a quote is arithmetic on your device.',
    glossary: ['weight', 'vsize', 'fee-rate', 'witness', 'postage', 'lane'],
  },
  {
    id: 'inscribe',
    number: 4,
    title: 'Commit and reveal',
    summary: 'Two transactions: the commit locks coins to your file\'s script, the reveal spends them and shows the file.',
    explanation: [
      'Taproot lets coins be locked to a script without showing it. The commit transaction sends coins to an address that commits to an envelope script containing your file and your public key.',
      'The reveal transaction spends that output by showing the script and a signature from your key. Showing the script is what writes the file into the witness, and the signature means only you could do it.',
      'Both are built as PSBTs and signed on your device: the throwaway key signs in the page, a real wallet signs in its own window. The page checks every signed transaction before it is broadcast.',
    ],
    onChain: 'Two transactions were broadcast: the commit (your coin → the envelope address) and the reveal (envelope address → your address, with the file in the witness).',
    glossary: ['commit', 'reveal', 'envelope', 'psbt', 'inscription', 'witness'],
  },
  {
    id: 'certificate',
    number: 5,
    title: 'Your certificate',
    summary: 'Your inscription id, where to look it up, and three quick questions.',
    explanation: [
      'Your file now has an inscription id: the reveal transaction id followed by i0. Explorers and ord servers index it by that id once they see the reveal.',
      'The transactions are real signet transactions. They confirm when a signet block includes them, usually within about ten minutes; until then they sit in the mempool.',
      'The same steps on mainnet cost real bitcoin and cannot be undone. That is why you practised here first.',
    ],
    onChain: 'Your inscription is in the reveal transaction\'s witness. Anyone can verify its bytes from the chain alone.',
    glossary: ['inscription-id', 'explorer', 'confirmation', 'txid'],
  },
];

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: readonly string[];
  /** Index into `options`. */
  answer: number;
  /** Shown after answering. */
  why: string;
}

export const QUIZ: readonly QuizQuestion[] = [
  {
    id: 'free-coins',
    prompt: 'Why were your test coins free?',
    options: ['Signet coins are for practice and have no value', 'scribb.it paid for them in real bitcoin', 'They were borrowed from mainnet and will be returned'],
    answer: 0,
    why: 'Signet is a separate test network. Its coins cannot be exchanged for bitcoin, so a faucet can give them away.',
  },
  {
    id: 'where-bytes',
    prompt: 'Where do the bytes of your file live now?',
    options: ['On a scribb.it server', 'In the witness of the reveal transaction', 'In your browser\'s sessionStorage'],
    answer: 1,
    why: 'The reveal transaction carries the envelope script, and with it the file, in its witness. Any node that has the block has the bytes.',
  },
  {
    id: 'two-transactions',
    prompt: 'Why did it take two transactions?',
    options: ['The second one is a backup copy', 'The commit locks coins to a script holding the file; the reveal spends them and shows that script', 'The second one pays a fee to scribb.it'],
    answer: 1,
    why: 'Taproot hides a script until it is used. The commit locks coins to it; the reveal uses it, which publishes the file.',
  },
];

export interface QuizResult {
  score: number;
  total: number;
  passed: boolean;
  correct: boolean[];
}

/** Pass = every question right. Answers are option indices in QUIZ order; missing answers count as wrong. */
export function scoreQuiz(answers: ReadonlyArray<number | null | undefined>): QuizResult {
  const correct = QUIZ.map((q, i) => answers[i] === q.answer);
  const score = correct.filter(Boolean).length;
  return { score, total: QUIZ.length, passed: score === QUIZ.length, correct };
}

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return GLOSSARY.find((g) => g.id === id);
}

export class UnknownStepError extends Error {
  constructor(readonly step: unknown) {
    super(`unknown playground step: ${String(step)} (use 1-5 or ${STEP_IDS.join(', ')})`);
    this.name = 'UnknownStepError';
  }
}

export function stepContent(step: StepId | number | string): StepContent {
  const s = typeof step === 'number' ? STEPS.find((x) => x.number === step) : STEPS.find((x) => x.id === step || String(x.number) === step);
  if (!s) throw new UnknownStepError(step);
  return s;
}

export interface StepExplanation {
  step: number;
  id: StepId;
  title: string;
  summary: string;
  explanation: string[];
  onChain: string;
  safety: string | null;
  glossary: GlossaryEntry[];
  goalSeconds: number;
  version: string;
}

/** Everything a reader (human or agent) needs about one step, glossary expanded. */
export function explainStep(step: StepId | number | string): StepExplanation {
  const s = stepContent(step);
  return {
    step: s.number,
    id: s.id,
    title: s.title,
    summary: s.summary,
    explanation: [...s.explanation],
    onChain: s.onChain,
    safety: s.safety ?? null,
    glossary: s.glossary.map((id) => glossaryEntry(id)!),
    goalSeconds: GOAL_SECONDS,
    version: PLAYGROUND_VERSION,
  };
}

/** The whole playground as data: the JSON twin of the page (`playground.json`). */
export function playgroundDocument() {
  return {
    name: 'scribb.it Signet Playground',
    version: PLAYGROUND_VERSION,
    network: 'signet' as const,
    goalSeconds: GOAL_SECONDS,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    steps: STEPS.map((s) => explainStep(s.id)),
    glossary: GLOSSARY.map((g) => ({ ...g })),
    quiz: QUIZ.map((q) => ({ id: q.id, prompt: q.prompt, options: [...q.options], answer: q.answer, why: q.why })),
  };
}
