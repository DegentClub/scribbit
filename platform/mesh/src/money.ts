// SignedInvoice v1 and SignedReceipt v1 - the documents that cross an organisation
// boundary. A port of flashyos-wdk's packages/wallet-wdk/src/interop.ts, field for
// field and code for code, checked against docs/wallet/schema/signed-invoice.json and
// signed-receipt.json.
//
// Canonical form for both signatures: the signed fields only, keys sorted, no
// whitespace, `sig` omitted. `invoiceHash` is sha256 of the canonical invoice; the
// receipt names the invoice by it.
//
// SCRIBBIT EXTENSION, clearly marked below: the `btc:` chain family. FlashyOS's chain
// regex already admits `btc:<id>` but defines no ids and checks no addresses. We
// define `btc:mainnet`, `btc:testnet`, `btc:testnet4` and `btc:signet`, and
// `verifyInvoice(..., { btcDestination: true })` additionally requires a well-formed
// bech32/bech32m segwit address for the network (code BAD_DESTINATION, ours).
import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { decodeSegwitAddress, type SegwitAddress } from './bech32.ts';
import { canonicalBytes, fromBase64Url, sha256Hex, toBase64Url } from './canonical.ts';
import { asPrivateKey, normalizePem } from './keys.ts';

export { generateKeyPair, keyFingerprint, publicKeyOf, type Ed25519KeyPair } from './keys.ts';

export interface InvoicePayee {
  /** Who is asking, for the human reading the receipt. */
  name: string;
  /** Ed25519 public key, SPKI PEM. The invoice is verified against this key. */
  publicKey: string;
}

export interface SignedInvoicePayload {
  version: 1;
  /** The payee's own id for the invoice; unique under its key. One settlement per (payer org, id). */
  id: string;
  payee: InvoicePayee;
  /** `<family>:<chainId>`. */
  chain: string;
  /** Exact contract address, or "native". */
  asset: string;
  /** Base units, decimal string. */
  amount: string;
  /** The payee's receiving address on `chain`. Must be on the paying agent's allowlist. */
  destination: string;
  memo: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedInvoice extends SignedInvoicePayload {
  /** base64url(ed25519(canonical payload)) under `payee.publicKey`. */
  sig: string;
}

export interface ReceiptPayer {
  /** The paying org's slug. */
  org: string;
  agentName: string;
  /** The plane's authorization public key, SPKI PEM. */
  publicKey: string;
}

export interface SignedReceiptPayload {
  version: 1;
  invoiceId: string;
  /** sha256 of the invoice's canonical bytes, hex. */
  invoiceHash: string;
  payer: ReceiptPayer;
  payee: InvoicePayee;
  chain: string;
  asset: string;
  /** What was authorized and spent, base units. */
  amount: string;
  destination: string;
  txHash: string;
  outcome: 'CONFIRMED' | 'REVERTED';
  authorizationId: string;
  settledAt: string;
}

export interface SignedReceipt extends SignedReceiptPayload {
  /** base64url(ed25519(canonical payload)) under `payer.publicKey`. */
  sig: string;
}

export const INVOICE_SIGNED_FIELDS = ['version', 'id', 'payee', 'chain', 'asset', 'amount', 'destination', 'memo', 'issuedAt', 'expiresAt'] as const;
export const RECEIPT_SIGNED_FIELDS = [
  'version', 'invoiceId', 'invoiceHash', 'payer', 'payee', 'chain', 'asset', 'amount', 'destination', 'txHash', 'outcome', 'authorizationId', 'settledAt',
] as const;

export const INVOICE_SCHEMA_ID = 'https://flashyos.com/schema/wallet/signed-invoice.json';
export const RECEIPT_SCHEMA_ID = 'https://flashyos.com/schema/wallet/signed-receipt.json';

function canonical(fields: readonly string[], value: Record<string, unknown>): Buffer {
  const picked: Record<string, unknown> = {};
  for (const key of fields) picked[key] = value[key];
  return canonicalBytes(picked);
}

export const canonicalInvoice = (invoice: SignedInvoicePayload | SignedInvoice): Buffer => canonical(INVOICE_SIGNED_FIELDS, invoice as unknown as Record<string, unknown>);
export const canonicalReceipt = (receipt: SignedReceiptPayload | SignedReceipt): Buffer => canonical(RECEIPT_SIGNED_FIELDS, receipt as unknown as Record<string, unknown>);

/** sha256 of the canonical invoice, hex. Stable across re-serialization; changes if any signed field changes. */
export const invoiceHash = (invoice: SignedInvoicePayload | SignedInvoice): string => sha256Hex(canonicalInvoice(invoice));

/** A payee signs its invoice with its own Ed25519 private key (PKCS#8 PEM or KeyObject). */
export function signInvoice(payload: SignedInvoicePayload, privateKey: string | KeyObject): SignedInvoice {
  return { ...payload, sig: toBase64Url(edSign(null, canonicalInvoice(payload), asPrivateKey(privateKey))) };
}

/** The plane signs a receipt with its authorization key. */
export function signReceipt(payload: SignedReceiptPayload, privateKey: string | KeyObject): SignedReceipt {
  return { ...payload, sig: toBase64Url(edSign(null, canonicalReceipt(payload), asPrivateKey(privateKey))) };
}

/** FlashyOS's verdict codes. */
export type InteropCheck = { ok: true } | { ok: false; code: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'WRONG_KEY' };
/** InteropCheck plus BAD_DESTINATION, which only the scribbit `btcDestination` option can produce. */
export type InvoiceCheck = InteropCheck | { ok: false; code: 'BAD_DESTINATION'; detail: string };

export const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
export const CHAIN_RE = /^(evm|tron|ton|solana|btc):[A-Za-z0-9_-]+$/;
export const CLOCK_SKEW_MS = 30_000;
const isIso = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s));

function shapeOfInvoice(v: unknown): v is SignedInvoice {
  const i = v as SignedInvoice;
  return (
    !!i && typeof i === 'object' && i.version === 1 && typeof i.id === 'string' && i.id.length > 0 &&
    !!i.payee && typeof i.payee.name === 'string' && typeof i.payee.publicKey === 'string' &&
    typeof i.chain === 'string' && CHAIN_RE.test(i.chain) && typeof i.asset === 'string' && i.asset.length > 0 &&
    typeof i.amount === 'string' && AMOUNT_RE.test(i.amount) && typeof i.destination === 'string' && i.destination.length > 0 &&
    typeof i.memo === 'string' && isIso(i.issuedAt) && isIso(i.expiresAt) && typeof i.sig === 'string' && i.sig.length > 0
  );
}

/**
 * Signature under the invoice's own key, plus its window (30 s skew on issuedAt).
 * Never throws. Verifying against the key INSIDE the document proves only that the
 * holder of that key wrote it; whether that key may be paid is the paying agent's
 * allowlist's decision, not this function's.
 */
export function verifyInvoice(invoice: unknown, now: Date = new Date(), options: { btcDestination?: boolean } = {}): InvoiceCheck {
  if (!shapeOfInvoice(invoice)) return { ok: false, code: 'MALFORMED' };
  if (options.btcDestination && isBtcChain(invoice.chain)) {
    const dest = validateBtcDestination(invoice.chain, invoice.destination);
    if (!dest.ok) return { ok: false, code: 'BAD_DESTINATION', detail: dest.reason };
  }
  let valid = false;
  try {
    valid = edVerify(null, canonicalInvoice(invoice), createPublicKey(invoice.payee.publicKey), fromBase64Url(invoice.sig));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'BAD_SIGNATURE' };
  if (now.getTime() + CLOCK_SKEW_MS < Date.parse(invoice.issuedAt)) return { ok: false, code: 'NOT_YET_VALID' };
  if (now.getTime() > Date.parse(invoice.expiresAt)) return { ok: false, code: 'EXPIRED' };
  return { ok: true };
}

function shapeOfReceipt(v: unknown): v is SignedReceipt {
  const r = v as SignedReceipt;
  return (
    !!r && typeof r === 'object' && r.version === 1 && typeof r.invoiceId === 'string' && /^[0-9a-f]{64}$/.test(r.invoiceHash ?? '') &&
    !!r.payer && typeof r.payer.org === 'string' && typeof r.payer.agentName === 'string' && typeof r.payer.publicKey === 'string' &&
    !!r.payee && typeof r.payee.name === 'string' && typeof r.payee.publicKey === 'string' &&
    typeof r.chain === 'string' && typeof r.asset === 'string' && typeof r.amount === 'string' && AMOUNT_RE.test(r.amount) &&
    typeof r.destination === 'string' && typeof r.txHash === 'string' && (r.outcome === 'CONFIRMED' || r.outcome === 'REVERTED') &&
    typeof r.authorizationId === 'string' && isIso(r.settledAt) && typeof r.sig === 'string'
  );
}

export interface VerifyReceiptOptions {
  /** The one plane key you already trust; a receipt whose embedded key differs is WRONG_KEY even if self-consistent. */
  expectedPayerKey?: string;
  /** A set of keys the verifier trusts (a plane document's keys, retired ones included, so a receipt outlives a rotation). */
  trustedKeys?: string[];
  /** With an invoice given, the receipt must name that invoice's hash. */
  invoice?: SignedInvoice | SignedInvoicePayload;
}

/** A receipt verifies under the plane's public key. A document cannot vouch for itself: pass the key you trust. */
export function verifyReceipt(receipt: unknown, options: VerifyReceiptOptions = {}): InteropCheck {
  if (!shapeOfReceipt(receipt)) return { ok: false, code: 'MALFORMED' };
  if (options.expectedPayerKey !== undefined && normalizePem(options.expectedPayerKey) !== normalizePem(receipt.payer.publicKey)) return { ok: false, code: 'WRONG_KEY' };
  if (options.trustedKeys !== undefined && !options.trustedKeys.some((k) => normalizePem(k) === normalizePem(receipt.payer.publicKey))) return { ok: false, code: 'WRONG_KEY' };
  if (options.invoice && invoiceHash(options.invoice) !== receipt.invoiceHash) return { ok: false, code: 'BAD_SIGNATURE' };
  try {
    const ok = edVerify(null, canonicalReceipt(receipt), createPublicKey(receipt.payer.publicKey), fromBase64Url(receipt.sig));
    return ok ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, code: 'BAD_SIGNATURE' };
  }
}

/** The receipt payload that settles `invoice`: the invoice's own money fields copied, its hash named. */
export function receiptFor(
  invoice: SignedInvoice,
  settlement: { payer: ReceiptPayer; txHash: string; outcome: 'CONFIRMED' | 'REVERTED'; authorizationId: string; settledAt: string },
): SignedReceiptPayload {
  return {
    version: 1,
    invoiceId: invoice.id,
    invoiceHash: invoiceHash(invoice),
    payer: settlement.payer,
    payee: invoice.payee,
    chain: invoice.chain,
    asset: invoice.asset,
    amount: invoice.amount,
    destination: invoice.destination,
    txHash: settlement.txHash,
    outcome: settlement.outcome,
    authorizationId: settlement.authorizationId,
    settledAt: settlement.settledAt,
  };
}

// ─── SCRIBBIT EXTENSION: the btc: chain family ───────────────────────────────

export type BtcNetwork = 'mainnet' | 'testnet' | 'signet';

/** The `btc:` chain ids this package defines, and the bech32 hrp each network's addresses carry. */
export const BTC_CHAINS: Readonly<Record<string, { network: BtcNetwork; hrp: string }>> = Object.freeze({
  'btc:mainnet': { network: 'mainnet', hrp: 'bc' },
  'btc:testnet': { network: 'testnet', hrp: 'tb' },
  'btc:testnet4': { network: 'testnet', hrp: 'tb' },
  'btc:signet': { network: 'signet', hrp: 'tb' },
});

/** The `asset` of native bitcoin on a `btc:` chain. */
export const BTC_NATIVE_ASSET = 'native';

export const isBtcChain = (chain: string): boolean => chain.startsWith('btc:');

export type BtcDestinationCheck = ({ ok: true; chain: string; network: BtcNetwork } & SegwitAddress) | { ok: false; reason: string };

/** Is `address` a well-formed bech32/bech32m segwit address for the network `chain` names? Never throws. */
export function validateBtcDestination(chain: string, address: string): BtcDestinationCheck {
  const params = BTC_CHAINS[chain];
  if (!params) return { ok: false, reason: `unknown btc chain "${chain}" — one of ${Object.keys(BTC_CHAINS).join(', ')}` };
  if (typeof address !== 'string') return { ok: false, reason: 'destination is not a string' };
  const decoded = decodeSegwitAddress(params.hrp, address);
  if (!decoded) return { ok: false, reason: `"${address}" is not a valid ${params.network} segwit address (hrp "${params.hrp}")` };
  return { ok: true, chain, network: params.network, ...decoded };
}
