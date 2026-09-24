/**
 * Side effects of the ordinals flow, written against the service ports so their ORDER is testable.
 *
 *   quote:            leaf key per wallet capabilities → commit address → exact reveal weight/fee → lane
 *   prepareCommit:    payment UTXOs → funding PSBT (commit at vout 0) + its txid → unsigned reveal PSBT
 *   signAndBroadcastCommit: wallet signs WITHOUT broadcasting → txid must be unchanged → app broadcasts
 *                     → pending mint saved BEFORE the broadcast returns
 *   signAndBroadcastReveal: wallet signs the tapscript input → finalizeWalletSignedReveal verifies the
 *                     signature → broadcast via wallet or Esplora → inscription id
 *   rescue:           rebuild [commit] → [child] from the pending record, re-sign, broadcast
 */
import type { InscriptionContent, Network } from '@bsh/inscription';
import { hex } from '@scure/base';
import type { Services, WalletSession } from '../../services/types';
import type { ContentItem, OrdinalsOptions, QuoteView, CommitView, RevealView } from './state';
import { planRevealSigning } from '../../lib/walletRouting';
import { assertTxidUnchanged, buildFundingPsbt } from '../../lib/funding';
import { bytesToBase64, base64ToBytes, clearPendingOrdinals, savePendingOrdinals, type KeyValueStore, type PendingOrdinals } from '../../lib/pending';
import { UserFacingError } from '../../lib/errors';

export function toContent(item: ContentItem, options: OrdinalsOptions): InscriptionContent {
  // Normalise to this realm's Uint8Array (bytes may come from a File / TextEncoder of another realm).
  const content: InscriptionContent = { contentType: item.contentType, body: item.bytes instanceof Uint8Array ? item.bytes : Uint8Array.from(item.bytes) };
  const parent = options.parentId.trim();
  if (parent) {
    if (!/^[0-9a-f]{64}i\d+$/i.test(parent)) throw new UserFacingError(`"${parent}" is not an inscription id.`, 'A parent id looks like <64 hex txid>i<index>, e.g. …abcdi0. Leave it empty for no parent.');
    content.parentId = parent.toLowerCase();
  }
  const meta = options.metadataJson.trim();
  if (meta) content.metadata = encodeMetadata(meta);
  return content;
}

/** Metadata (tag 5) is CBOR. A tiny encoder for JSON values: strings, numbers, booleans, null, arrays, objects. */
export function encodeMetadata(json: string): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new UserFacingError('Metadata must be valid JSON.', 'It is stored as CBOR in the inscription (tag 5). Fix the JSON or clear the field.');
  }
  return cbor(value);
}

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function cbor(v: unknown): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  const put = (x: unknown): void => {
    if (x === null || x === undefined) out.push(0xf6);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (typeof x === 'number') {
      if (Number.isInteger(x) && Math.abs(x) < 2 ** 32) out.push(...cborHead(x >= 0 ? 0 : 1, x >= 0 ? x : -1 - x));
      else {
        const b = new DataView(new ArrayBuffer(8));
        b.setFloat64(0, x);
        out.push(0xfb, ...new Uint8Array(b.buffer));
      }
    } else if (typeof x === 'string') {
      const b = enc.encode(x);
      out.push(...cborHead(3, b.length), ...b);
    } else if (Array.isArray(x)) {
      out.push(...cborHead(4, x.length));
      for (const i of x) put(i);
    } else if (typeof x === 'object') {
      const entries = Object.entries(x as Record<string, unknown>);
      out.push(...cborHead(5, entries.length));
      for (const [k, val] of entries) {
        put(k);
        put(val);
      }
    } else throw new UserFacingError(`Metadata cannot contain a ${typeof x}.`, 'Use strings, numbers, booleans, arrays and objects.');
  };
  put(v);
  return new Uint8Array(out);
}

export function quoteItem(services: Services, args: { network: Network; wallet: WalletSession; item: ContentItem; options: OrdinalsOptions; feeRate: number }): QuoteView {
  const plan = planRevealSigning(args.wallet);
  const content = toContent(args.item, args.options);
  const q = services.inscription.quote({ content, recipientAddress: args.wallet.ordinals.address, network: args.network, feeRate: args.feeRate, postage: args.options.postage });
  const commitAddress = services.inscription.commitAddress(plan.leafPubkey, content, args.network);
  return { quote: q, feeRate: args.feeRate, fundingFee: null, fundingVsize: null, plan, commitAddress };
}

export async function prepareCommit(services: Services, args: { network: Network; wallet: WalletSession; item: ContentItem; options: OrdinalsOptions; quote: QuoteView }): Promise<{ commit: CommitView; reveal: RevealView }> {
  const utxos = await services.chain.getUtxos(args.wallet.payment.address);
  const funding = buildFundingPsbt({
    network: args.network,
    utxos,
    payment: args.wallet.payment,
    ordinalsAddress: args.wallet.ordinals.address,
    commitAddress: args.quote.commitAddress,
    commitValue: Number(args.quote.quote.commitValue),
    feeRate: args.quote.feeRate,
  });
  const content = toContent(args.item, args.options);
  const reveal = services.inscription.buildUnsignedReveal({
    network: args.network,
    leafPubkey: args.quote.plan.leafPubkey,
    content,
    commitOutpoint: { txid: funding.txid, vout: funding.commitVout },
    commitValue: args.quote.quote.commitValue,
    recipientAddress: args.wallet.ordinals.address,
    postage: args.options.postage,
    sighash: args.quote.plan.sighash,
  });
  if (reveal.commitAddress !== args.quote.commitAddress) throw new Error('commit address drift between quote and reveal (bug)');
  return {
    commit: { psbtBase64: funding.psbtBase64, txid: funding.txid, commitVout: funding.commitVout, commitValue: args.quote.quote.commitValue, inputsToSign: funding.inputsToSign, fundingFee: funding.selection.fee, inscription: { envelopeScriptHex: reveal.leafScriptHex, commitAddress: reveal.commitAddress } },
    reveal: { psbtBase64: reveal.psbtBase64, inscription: { envelopeScriptHex: reveal.leafScriptHex, commitAddress: reveal.commitAddress } },
  };
}

export function pendingRecord(args: { network: Network; wallet: WalletSession; item: ContentItem; options: OrdinalsOptions; quote: QuoteView; commit: CommitView }): PendingOrdinals {
  const content = toContent(args.item, args.options);
  return {
    kind: 'ordinals',
    network: args.network,
    walletId: args.wallet.id,
    ordinalsAddress: args.wallet.ordinals.address,
    contentType: args.item.contentType,
    bodyBase64: bytesToBase64(args.item.bytes),
    sha256: args.item.sha256,
    ...(content.parentId ? { parentId: content.parentId } : {}),
    ...(content.metadata ? { metadataBase64: bytesToBase64(content.metadata) } : {}),
    leafPubkeyHex: hex.encode(args.quote.plan.leafPubkey),
    leafKeyKind: args.quote.plan.leafKeyKind,
    commitAddress: args.quote.commitAddress,
    commitTxid: args.commit.txid,
    commitVout: args.commit.commitVout,
    commitValue: args.commit.commitValue.toString(),
    postage: args.options.postage.toString(),
    feeRate: args.quote.feeRate,
    fileName: args.item.fileName,
    savedAt: Date.now(),
  };
}

/** The wallet signs the funding transaction without broadcasting; the txid is re-checked; the app broadcasts. */
export async function signAndBroadcastCommit(services: Services, store: KeyValueStore | null, args: { wallet: WalletSession; commit: CommitView; pending: PendingOrdinals }): Promise<string> {
  const signed = await args.wallet.signPsbt(args.commit.psbtBase64, { inputsToSign: args.commit.inputsToSign, finalize: false, broadcast: false, ...(args.commit.inscription ? { inscription: args.commit.inscription } : {}) });
  const { hex: rawHex } = assertTxidUnchanged(signed.psbtBase64, args.commit.txid);
  // Saved BEFORE the broadcast: if the tab dies mid-flight the reveal can still be built from this record.
  savePendingOrdinals(store, args.pending);
  const txid = await services.chain.broadcast(rawHex);
  if (txid !== args.commit.txid) throw new UserFacingError(`The network reported txid ${txid}, not the expected ${args.commit.txid}.`, 'Do not sign anything else. The pending mint is saved; use "rescue" once the commit confirms, or contact support.');
  return txid;
}

export function contentFromPending(p: PendingOrdinals): InscriptionContent {
  const c: InscriptionContent = { contentType: p.contentType, body: base64ToBytes(p.bodyBase64) };
  if (p.parentId) c.parentId = p.parentId;
  if (p.metadataBase64) c.metadata = base64ToBytes(p.metadataBase64);
  return c;
}

/** Rebuild the unsigned reveal from a pending record (resume after reload). */
export function revealFromPending(services: Services, p: PendingOrdinals, sighash: 'default' | 'all'): RevealView {
  const r = services.inscription.buildUnsignedReveal({
    network: p.network,
    leafPubkey: hex.decode(p.leafPubkeyHex),
    content: contentFromPending(p),
    commitOutpoint: { txid: p.commitTxid, vout: p.commitVout },
    commitValue: BigInt(p.commitValue),
    recipientAddress: p.ordinalsAddress,
    postage: BigInt(p.postage),
    sighash,
  });
  if (r.commitAddress !== p.commitAddress) throw new UserFacingError('The saved pending mint does not reproduce its commit address.', 'The record is corrupt. Nothing can be built from it; keep the commit txid and contact support.');
  return { psbtBase64: r.psbtBase64, inscription: { envelopeScriptHex: r.leafScriptHex, commitAddress: r.commitAddress } };
}

export async function signAndBroadcastReveal(services: Services, store: KeyValueStore | null, args: { wallet: WalletSession; reveal: RevealView; inputIndex?: number }): Promise<{ txid: string; hex: string; weight: number; inscriptionId: string; broadcastVia: 'wallet' | 'esplora' }> {
  const plan = planRevealSigning(args.wallet, args.inputIndex ?? 0);
  const signed = await args.wallet.signPsbt(args.reveal.psbtBase64, { inputsToSign: [plan.inputToSign], finalize: false, broadcast: false, ...(args.reveal.inscription ? { inscription: args.reveal.inscription } : {}) });
  const final = services.inscription.finalizeWalletSignedReveal(signed.psbtBase64);
  let txid: string;
  let via: 'wallet' | 'esplora' = 'esplora';
  if (plan.broadcastVia === 'wallet' && args.wallet.pushTx) {
    try {
      txid = await args.wallet.pushTx(final.hex);
      via = 'wallet';
    } catch {
      txid = await services.chain.broadcast(final.hex);
    }
  } else txid = await services.chain.broadcast(final.hex);
  if (txid !== final.txid) throw new UserFacingError(`The relay reported txid ${txid}, not ${final.txid}.`, 'Check both on the explorer before signing again. The pending mint is kept.');
  clearPendingOrdinals(store);
  return { txid, hex: final.hex, weight: final.weight, inscriptionId: `${final.txid}i0`, broadcastVia: via };
}

/** Stuck commit? Rebuild a fresh [commit] → [child] reveal at the saved parameters and sign it again. */
export function rescueFromPending(services: Services, p: PendingOrdinals, sighash: 'default' | 'all'): RevealView {
  const r = services.inscription.buildUnsignedRescue({
    network: p.network,
    leafPubkey: hex.decode(p.leafPubkeyHex),
    content: contentFromPending(p),
    commitOutpoint: { txid: p.commitTxid, vout: p.commitVout },
    commitValue: BigInt(p.commitValue),
    recipientAddress: p.ordinalsAddress,
    postage: BigInt(p.postage),
    sighash,
  });
  const leaf = revealFromPending(services, p, sighash).inscription;
  return { psbtBase64: r.psbtBase64, ...(leaf ? { inscription: leaf } : {}) };
}
