/**
 * `scribbit anchor` / `scribbit anchor-verify`: a checkpoint/1 head (@bsh/mesh) as a Bitcoin inscription.
 *
 * The anchor's body is the canonical JSON (keys sorted, no whitespace) of the five fields that identify
 * a head - `{ anchor: "1", origin, size, root, at }` - under the content type
 * `application/vnd.flashyos.checkpoint+json`. Both are OUR proposal: FlashyOS specifies the head and
 * its Merkle construction, and says a head needs an outside witness, but names no anchor format.
 * Everything below the body (envelope, weight, fee, commit address) is the ordinary single-layout
 * reveal `scribbit quote` prices, so an anchor costs exactly what the quote says.
 */
import { commitAddress, estimateRevealWeight, inscriptionScriptLength, laneFor, LIMITS, quoteReveal, type InscriptionContent } from '@bsh/inscription';
import {
  canonicalStringify,
  type CheckpointHead,
  checkpointHead,
  type Claim,
  claimsOf,
  HEX64_RE,
  type InclusionProof,
  inclusionProof,
  isRecord,
  verifyCheckpointHead,
  verifyInclusionProof,
} from '@bsh/mesh';
import { failure, helpFor, parseArgs, rejected, usage, type FlagSpec, type ParsedArgs } from '../args.js';
import { fmt, GLOBAL_FLAGS, NETWORK_FLAG, parseNetwork, parsePositiveNumber, parsePubkey, parseSats, readInput, recipientScript, table, toHex } from '../common.js';
import type { CliIO } from '../io.js';
import { feeProviderFor } from './quote.js';
import type { CommandResult } from './types.js';

/** Our proposal (not FlashyOS's): the media type of an anchored checkpoint/1 head. */
export const ANCHOR_CONTENT_TYPE = 'application/vnd.flashyos.checkpoint+json';
export const ANCHOR_VERSION = '1';

export interface AnchorBody {
  anchor: '1';
  origin: string;
  size: number;
  root: string;
  at: string;
}

/** The five fields of a head that the anchor commits to; `counts` and any `x-signature` stay off chain. */
export const anchorBody = (head: CheckpointHead): AnchorBody => ({ anchor: ANCHOR_VERSION, origin: head.origin, size: head.size, root: head.root, at: head.at });

/** The inscription body: canonical JSON of the anchor, UTF-8. Deterministic for a given head. */
export function anchorContent(head: CheckpointHead): { body: AnchorBody; text: string; content: InscriptionContent } {
  const body = anchorBody(head);
  const text = canonicalStringify(body);
  return { body, text, content: { contentType: ANCHOR_CONTENT_TYPE, body: new TextEncoder().encode(text) } };
}

/** A checkpoint/1 head read from disk, or exit 3 with what is wrong with it. */
export function parseCheckpointHead(bytes: Uint8Array, file: string): CheckpointHead {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw rejected('bad_checkpoint', `${file} is not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) throw rejected('bad_checkpoint', `${file} is not a JSON object`);
  if (doc.checkpoint !== '1') throw rejected('bad_checkpoint', `${file} does not declare checkpoint "1"`);
  if (typeof doc.origin !== 'string' || !doc.origin) throw rejected('bad_checkpoint', `${file}: origin is a non-empty string`);
  if (!Number.isInteger(doc.size) || (doc.size as number) < 0) throw rejected('bad_checkpoint', `${file}: size is a non-negative integer`);
  if (typeof doc.root !== 'string' || !HEX64_RE.test(doc.root)) throw rejected('bad_checkpoint', `${file}: root is a sha256 hex`);
  if (typeof doc.at !== 'string' || Number.isNaN(Date.parse(doc.at))) throw rejected('bad_checkpoint', `${file}: at is an ISO timestamp`);
  return doc as unknown as CheckpointHead;
}

const CLAIMS_FLAG: FlagSpec = { type: 'string', arg: '<fragments...>', description: 'Fragments the head covers (shiplog.json, directory.fragment.json ...); more may follow as bare arguments' };
const CLAIM_FLAG: FlagSpec = { type: 'string', arg: '<id>', description: 'A claim id (ship/<repo>/<sha12> ...) to prove against the anchored root' };

export const ANCHOR_FLAGS: Record<string, FlagSpec> = {
  network: { ...NETWORK_FLAG, description: 'mainnet | testnet | signet | regtest (required)' },
  'fee-rate': { type: 'string', arg: '<sat/vB>', description: 'Use this fee rate (no fee source is contacted)' },
  'fee-source': { type: 'string', arg: '<url>', description: 'Fee source as for `quote`: a scribb.it fee server (/v1/fees) or a mempool.space-compatible base URL' },
  pubkey: { type: 'string', arg: '<xonly>', description: 'Reveal x-only public key: also prints the commit address for this exact body' },
  recipient: { type: 'string', arg: '<address>', description: 'Where the anchor inscription lands (default: a P2TR output is assumed)' },
  postage: { type: 'string', arg: '<sats>', description: `Anchor output value (default ${LIMITS.DEFAULT_POSTAGE})` },
  claims: CLAIMS_FLAG,
  claim: CLAIM_FLAG,
  ...GLOBAL_FLAGS,
};

export const ANCHOR_HELP = helpFor(
  'anchor',
  'quote a checkpoint/1 head (@bsh/mesh) as an inscription, exactly',
  'scribbit anchor <checkpoint.json> --network <net> [--fee-rate <n> | --fee-source <url>] [--pubkey <xonly>] [--claims <fragments...>] [--claim <id>] [--json]',
  ANCHOR_FLAGS,
  [
    `Body: canonical JSON of { anchor: "1", origin, size, root, at } as ${ANCHOR_CONTENT_TYPE} (our proposal;`,
    'FlashyOS specifies the head, not how it is anchored). counts and x-signature are not inscribed.',
    'The quote is the single-layout reveal [commit] -> [anchor]: weight, vsize, lane, fee and commit value,',
    'plus the commit address when --pubkey is given. Fee rate resolves exactly as for `quote`.',
    'With --claims, the root is recomputed from the fragments; with --claim too, an inclusion proof is printed.',
  ].join('\n'),
);

export const ANCHOR_VERIFY_FLAGS: Record<string, FlagSpec> = { claim: CLAIM_FLAG, claims: CLAIMS_FLAG, ...GLOBAL_FLAGS };

export const ANCHOR_VERIFY_HELP = helpFor(
  'anchor-verify',
  'prove a claim id against an anchored checkpoint/1 root, and refuse anything that does not hash to it',
  'scribbit anchor-verify <checkpoint.json> --claim <id> --claims <fragments...> [--json]',
  ANCHOR_VERIFY_FLAGS,
  [
    'Reads every sealed record ({ id, digest }) in the fragments, sorts them by id, and builds the RFC 6962',
    'inclusion proof for --claim: leaf index, tree size and audit path. The proof is verified against the root',
    'the head names (the one that was anchored), not the root the fragments produce - a tampered fragment,',
    'a tampered head or an unknown claim exits 3.',
  ].join('\n'),
);

const HOW = [
  'A verifier holding the anchored root proves a claim id like this:',
  '1. fetch the fragments the head covers (<origin>/.well-known/shiplog.json and /directory.fragment.json), or pass them with --claims',
  '2. take every sealed record ({ id, digest }) in them, sorted by id; the RFC 6962 root over the digests must equal the anchored root',
  '3. inclusionProof(claims, id) gives the leaf index, size and audit path; verifyInclusion(digest, index, size, path, root) must hold',
  '4. the record itself must re-seal: sha256(canonical(record without digest)) == digest',
  'scribbit anchor-verify <checkpoint.json> --claim <id> --claims <fragments...> does steps 2-4.',
];

/** `<checkpoint.json>` plus fragments from `--claims` and any further bare arguments. */
function inputsOf(args: ParsedArgs, command: string): { file: string; fragments: string[] } {
  const [file, ...rest] = args.positionals;
  if (!file) throw usage(`missing <checkpoint.json>: scribbit ${command} <checkpoint.json> ...`);
  const claims = args.flags.claims as string | undefined;
  const fragments = [...(claims !== undefined ? [claims] : []), ...rest];
  if (claims === undefined && rest.length) throw usage(`unexpected argument "${rest[0]}" (fragments follow --claims)`);
  return { file, fragments };
}

async function readClaims(io: CliIO, fragments: string[]): Promise<Claim[]> {
  const docs: unknown[] = [];
  for (const f of fragments) {
    const bytes = await readInput(io, f, 'fragment');
    try {
      docs.push(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
      throw rejected('bad_fragment', `${f} is not JSON: ${(e as Error).message}`);
    }
  }
  return claimsOf(docs);
}

function signatureOf(head: CheckpointHead): Record<string, unknown> | null {
  if (!('x-signature' in head)) return null;
  const check = verifyCheckpointHead(head);
  return check.ok ? { ok: true, kid: check.kid, trusted: null } : { ok: false, code: check.code, detail: check.detail };
}

export async function anchorCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, ANCHOR_FLAGS);
  if (args.flags.help) return { help: ANCHOR_HELP };
  const network = parseNetwork(args.flags.network);
  if (args.flags['fee-rate'] !== undefined && args.flags['fee-source'] !== undefined) throw usage('--fee-rate and --fee-source are mutually exclusive');
  const explicitRate = args.flags['fee-rate'] !== undefined ? parsePositiveNumber(args.flags['fee-rate'], 'fee-rate') : undefined;
  const postage = args.flags.postage !== undefined ? parseSats(args.flags.postage, 'postage') : LIMITS.DEFAULT_POSTAGE;
  if (postage < LIMITS.DUST_P2TR) throw usage(`--postage ${postage} is below the P2TR dust limit (${LIMITS.DUST_P2TR} sats)`);
  const pubkey = args.flags.pubkey !== undefined ? parsePubkey(args.flags.pubkey) : undefined;
  const recipient = recipientScript(args.flags.recipient, network);
  const { file, fragments } = inputsOf(args, 'anchor');
  const claimId = args.flags.claim as string | undefined;
  if (claimId !== undefined && !fragments.length) throw usage('--claim needs the fragments it lives in: --claims <fragments...>');

  const head = parseCheckpointHead(await readInput(io, file, 'checkpoint'), file);
  const { body, text, content } = anchorContent(head);
  const weight = estimateRevealWeight({ content, withParent: false, recipientScript: recipient.script });
  const lane = laneFor(weight);
  if (lane === null) throw rejected('too_large', `anchor reveal weight ${fmt(weight)} WU exceeds the block lane`); // unreachable for a five-field body; kept for the type
  const vsize = Math.ceil(weight / 4);

  const warnings: string[] = [];
  let feeRate: number;
  let feeSource: Record<string, unknown>;
  if (explicitRate !== undefined) {
    feeRate = explicitRate;
    feeSource = { kind: 'flag' };
    if (feeRate < 1) warnings.push(`fee rate ${feeRate} sat/vB is below the default 1 sat/vB min relay; most nodes will not relay it`);
  } else {
    const { provider, kind, url } = feeProviderFor(args.flags['fee-source'] as string | undefined, network, io);
    let fees;
    try {
      fees = await provider.getFees();
    } catch (e) {
      throw failure('fee_source_failed', `fee source ${url} failed: ${(e as Error).message}`);
    }
    feeRate = fees.standard.normal;
    feeSource = { kind, url, pick: 'standard.normal', fetchedAt: fees.fetchedAt, stale: fees.stale };
    if (fees.stale) warnings.push('fee data is stale (every upstream refresh failed); double-check before paying');
  }
  const q = quoteReveal({ revealWeight: weight, feeRate, postage });

  const commit = pubkey ? commitAddress(pubkey, content, network) : null;
  const signature = signatureOf(head);
  if (signature && !signature.ok) warnings.push(`the head carries an x-signature that does not verify (${String(signature.code)}); anchoring it anchors a head nobody vouched for`);

  const inclusion: Record<string, unknown> = { how: HOW };
  let proof: InclusionProof | null = null;
  if (fragments.length) {
    const claims = await readClaims(io, fragments);
    const recomputed = checkpointHead(claims, head.origin, head.at);
    inclusion.fragments = fragments;
    inclusion.claims = claims.length;
    inclusion.recomputedRoot = recomputed.root;
    inclusion.rootMatches = recomputed.root === head.root && recomputed.size === head.size;
    if (!inclusion.rootMatches) warnings.push(`the fragments do not hash to the head: ${claims.length} claims, root ${recomputed.root} (head: ${head.size}, ${head.root})`);
    if (claimId !== undefined) {
      proof = inclusionProof(claims, claimId, head.origin);
      inclusion.claim = claimId;
      inclusion.proof = proof;
      inclusion.verified = proof ? verifyInclusionProof(proof, head.root) : false;
      if (!proof) warnings.push(`claim ${claimId} is not in the fragments`);
    }
  }

  const data = {
    file,
    network,
    head: { origin: head.origin, size: head.size, root: head.root, at: head.at },
    contentType: ANCHOR_CONTENT_TYPE,
    body,
    bodyText: text,
    bodyBytes: content.body.length,
    envelope: { scriptBytes: inscriptionScriptLength(content), bodyChunks: Math.ceil(content.body.length / LIMITS.MAX_SCRIPT_ELEMENT_SIZE) },
    reveal: { layout: 'single', weight, vsize, lane },
    recipient: recipient.kind,
    feeRate,
    feeSource,
    fees: { revealFee: Number(q.revealFee), postage: Number(postage), commitValue: Number(q.commitValue) },
    commit: commit ? { pubkey: toHex(pubkey!), address: commit.address, scriptPubKey: toHex(commit.script), tapLeafHash: toHex(commit.tapLeafHash), leafScriptBytes: commit.leafScript.length } : null,
    signature,
    inclusion,
    warnings,
  };

  const rows: Array<[string, string]> = [
    ['checkpoint', `${file} (origin ${head.origin}, ${fmt(head.size)} claims, at ${head.at})`],
    ['root', head.root],
    ['body', `${text} (${fmt(content.body.length)} bytes, ${ANCHOR_CONTENT_TYPE})`],
    ['network', network],
    ['envelope', `${fmt(data.envelope.scriptBytes)} bytes, ${data.envelope.bodyChunks} body chunk(s)`],
    ['reveal', `${fmt(weight)} WU / ${fmt(vsize)} vB (single layout)`],
    ['lane', lane],
    ['fee rate', `${feeRate} sat/vB (${feeSource.kind === 'flag' ? '--fee-rate' : `${String(feeSource.pick)} from ${String(feeSource.url)}`})`],
    ['reveal fee', `${fmt(q.revealFee)} sats`],
    ['postage', `${fmt(postage)} sats`],
    ['commit value', `${fmt(q.commitValue)} sats  <- fund the commit address with exactly this`],
  ];
  if (commit) rows.push(['commit address', commit.address], ['tapleaf hash', toHex(commit.tapLeafHash)]);
  else rows.push(['commit address', '- (pass --pubkey <xonly> to derive it)']);
  if (signature) rows.push(['x-signature', signature.ok ? `verifies under kid ${String(signature.kid)} (trust of that key is yours to decide)` : `does not verify: ${String(signature.code)}`]);
  const inclusionLines = ['', 'inclusion', ...HOW.map((l) => `  ${l}`)];
  if (fragments.length) {
    inclusionLines.push(`  fragments: ${fragments.join(', ')} -> ${fmt(inclusion.claims as number)} claims, root ${String(inclusion.recomputedRoot)} (${inclusion.rootMatches ? 'matches the head' : 'DOES NOT match the head'})`);
    if (claimId !== undefined) inclusionLines.push(proof ? `  ${claimId}: leaf ${proof.index} of ${proof.size}, path ${proof.path.length} hash(es), ${inclusion.verified ? 'proves against the anchored root' : 'DOES NOT prove against the anchored root'}` : `  ${claimId}: not in the fragments`);
  }
  const human = [table(rows), ...inclusionLines, ...warnings.map((w) => `warning: ${w}`)].join('\n');
  return { data, human };
}

export async function anchorVerifyCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, ANCHOR_VERIFY_FLAGS);
  if (args.flags.help) return { help: ANCHOR_VERIFY_HELP };
  const { file, fragments } = inputsOf(args, 'anchor-verify');
  const claimId = args.flags.claim as string | undefined;
  if (claimId === undefined) throw usage('--claim <id> is required');
  if (!fragments.length) throw usage('--claims <fragments...> is required (the files the claim lives in)');
  const head = parseCheckpointHead(await readInput(io, file, 'checkpoint'), file);
  const claims = await readClaims(io, fragments);
  const proof = inclusionProof(claims, claimId, head.origin);
  const base = { file, claim: claimId, head: { origin: head.origin, size: head.size, root: head.root, at: head.at }, claims: claims.length, fragments };
  if (!proof) throw rejected('claim_not_found', `${claimId} is not among the ${claims.length} sealed records in ${fragments.join(', ')}`, base);
  const verified = verifyInclusionProof(proof, head.root);
  if (!verified)
    throw rejected(
      'inclusion_failed',
      proof.size !== head.size || proof.root !== head.root
        ? `the fragments hash to size ${proof.size}, root ${proof.root}; the head anchors size ${head.size}, root ${head.root}`
        : `${claimId} does not prove against the anchored root`,
      { ...base, proof },
    );
  const signature = signatureOf(head);
  const data = { ...base, proof, verified: true, signature };
  const human = [
    table([
      ['checkpoint', `${file} (origin ${head.origin}, ${fmt(head.size)} claims, at ${head.at})`],
      ['root', head.root],
      ['claim', claimId],
      ['digest', proof.digest],
      ['leaf', `${proof.index} of ${proof.size}`],
      ['path', proof.path.length ? proof.path.join('\n' + ' '.repeat(12)) : '(single leaf: the root is the leaf hash)'],
      ['verified', `yes - ${claimId} is in the tree the anchored root commits to`],
      ...(signature ? [['x-signature', signature.ok ? `verifies under kid ${String(signature.kid)}` : `does not verify: ${String(signature.code)}`] as [string, string]] : []),
    ]),
    'Step 4 is yours: re-seal the record (sha256 of its canonical JSON without digest) and compare it to the digest above.',
  ].join('\n');
  return { data, human };
}
