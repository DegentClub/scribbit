// OperationRecord - what an agent proposes. FlashyOS docs/wallet/spec.md §1 and
// docs/wallet/schema/operation-record.json (flashyos-wdk, Apache-2.0), which mirror the
// shape of tetherto/wdk PR #88, rule for rule:
//   kind ∈ transfer | swap | bridge | meter; chain `<family>:<chainId>`; asset exact or
//   "native"; amount a non-negative base-unit integer as a decimal string; destination an
//   exact address, null only for a swap, `<targetChain>:<recipient>` for a bridge; raw
//   opaque. Shape problems are INVALID_RECORD, amount problems INVALID_AMOUNT - verdicts.
//
// OURS, marked: (1) `payee` - which ledger payee a destination is, matched by the
// `payee:<kind>` entries of an envelope; (2) on `btc:` chains the destination must be a
// bech32/bech32m segwit address for the chain's network (@bsh/mesh's checker) and an
// amount above the 21M BTC supply in sats is INVALID_AMOUNT.
import { AMOUNT_RE, BTC_CHAINS, CHAIN_RE, isBtcChain, validateBtcDestination } from '@bsh/mesh';

export const OPERATION_KINDS = ['transfer', 'swap', 'bridge', 'meter'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const DENIAL_CODES = [
  'SCOPE_MISSING',
  'NO_ENVELOPE',
  'ENVELOPE_INACTIVE',
  'KIND_NOT_PERMITTED',
  'ASSET_NOT_PERMITTED',
  'DESTINATION_NOT_PERMITTED',
  'PER_TX_CAP',
  'DAILY_CAP',
  'INVALID_AMOUNT',
  'INVALID_RECORD',
] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];

/** The ledger's payee kinds (contracts/openapi/ledger.yaml `PayeeKind`). */
export const PAYEE_KINDS = ['artist', 'club', 'platform', 'other'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export interface Payee {
  kind: PayeeKind;
  ref: string;
}

export interface OperationRecord {
  kind: OperationKind;
  chain: string;
  asset: string;
  /** Base units (sats on btc:), decimal string. */
  amount: string;
  /** Exact address; null only for kind swap. */
  destination: string | null;
  /** The originating call. Opaque; never used for a decision. */
  raw?: Record<string, unknown>;
  /** Ours: the ledger payee the destination is, for `payee:<kind>` envelope entries. */
  payee?: Payee;
}

export const NATIVE_ASSET = 'native';
/** 21 000 000 BTC in sats. Ours: a btc amount above the supply is not an amount. */
export const BTC_MAX_SATS = 2_100_000_000_000_000n;

const RECORD_KEYS = new Set(['kind', 'chain', 'asset', 'amount', 'destination', 'raw', 'payee']);
const BRIDGE_DEST_RE = /^((?:evm|tron|ton|solana|btc):[A-Za-z0-9_-]+):(.+)$/;

export type RecordCheck =
  | { ok: true; record: OperationRecord; amount: bigint }
  | { ok: false; code: 'INVALID_RECORD' | 'INVALID_AMOUNT'; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code: 'INVALID_RECORD' | 'INVALID_AMOUNT', reason: string): RecordCheck => ({ ok: false, code, reason });

export const familyOf = (chain: string): string => chain.slice(0, chain.indexOf(':'));

/** How FlashyOS compares addresses: byte-exact after lowercasing on EVM, byte-exact otherwise. Ours: bech32 is case-insensitive, so btc lowercases too. */
export function normalizeAddress(chain: string, value: string): string {
  const family = familyOf(chain);
  return family === 'evm' || family === 'btc' ? value.toLowerCase() : value;
}

/** A btc destination's problem, or undefined when it is a segwit address for `chain`'s network. */
function btcDestinationProblem(chain: string, destination: string): string | undefined {
  if (!BTC_CHAINS[chain]) return `unknown btc chain "${chain}" - one of ${Object.keys(BTC_CHAINS).join(', ')}`;
  const check = validateBtcDestination(chain, destination);
  return check.ok ? undefined : check.reason;
}

/**
 * Parses a proposed record. Never throws. On success the record is normalised (destination
 * and asset lowercased on evm/btc, `raw` and `payee` kept) and `amount` is the BigInt.
 */
export function parseOperationRecord(input: unknown): RecordCheck {
  if (!isPlainObject(input)) return fail('INVALID_RECORD', 'an operation record is a JSON object');
  for (const key of Object.keys(input)) if (!RECORD_KEYS.has(key)) return fail('INVALID_RECORD', `unknown member "${key}"`);
  for (const key of ['kind', 'chain', 'asset', 'amount', 'destination']) if (!(key in input)) return fail('INVALID_RECORD', `"${key}" is required`);
  const { kind, chain, asset, amount, destination, raw, payee } = input;
  if (typeof kind !== 'string' || !(OPERATION_KINDS as readonly string[]).includes(kind)) return fail('INVALID_RECORD', `kind must be one of ${OPERATION_KINDS.join(', ')}`);
  if (typeof chain !== 'string' || !CHAIN_RE.test(chain)) return fail('INVALID_RECORD', 'chain must be <family>:<chainId> (evm, tron, ton, solana, btc)');
  if (typeof asset !== 'string' || asset.length === 0) return fail('INVALID_RECORD', 'asset must be an exact contract address or "native"');
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) return fail('INVALID_AMOUNT', 'amount must be a non-negative integer in base units, as a decimal string');
  const value = BigInt(amount);
  if (isBtcChain(chain) && value > BTC_MAX_SATS) return fail('INVALID_AMOUNT', `amount ${amount} sats exceeds the bitcoin supply`);
  if (destination === null) {
    if (kind !== 'swap') return fail('INVALID_RECORD', 'destination may be null only for kind swap');
  } else if (typeof destination !== 'string' || destination.length === 0) {
    return fail('INVALID_RECORD', 'destination must be an exact address (or null for a swap)');
  }
  if (raw !== undefined && !isPlainObject(raw)) return fail('INVALID_RECORD', 'raw must be an object');
  let parsedPayee: Payee | undefined;
  if (payee !== undefined) {
    if (!isPlainObject(payee) || Object.keys(payee).some((k) => k !== 'kind' && k !== 'ref')) return fail('INVALID_RECORD', 'payee is { kind, ref }');
    if (typeof payee.kind !== 'string' || !(PAYEE_KINDS as readonly string[]).includes(payee.kind)) return fail('INVALID_RECORD', `payee.kind must be one of ${PAYEE_KINDS.join(', ')}`);
    if (typeof payee.ref !== 'string' || payee.ref.length < 1 || payee.ref.length > 128) return fail('INVALID_RECORD', 'payee.ref must be 1..128 characters');
    parsedPayee = { kind: payee.kind as PayeeKind, ref: payee.ref };
  }

  let normalizedDestination: string | null = null;
  if (typeof destination === 'string') {
    if (kind === 'bridge') {
      const m = BRIDGE_DEST_RE.exec(destination);
      if (!m) return fail('INVALID_RECORD', 'a bridge destination is <targetChain>:<recipient>');
      const target = m[1]!;
      const recipient = m[2]!;
      if (isBtcChain(target)) {
        const problem = btcDestinationProblem(target, recipient);
        if (problem) return fail('INVALID_RECORD', `bridge recipient: ${problem}`);
      }
      normalizedDestination = `${target}:${normalizeAddress(target, recipient)}`;
    } else {
      if (isBtcChain(chain)) {
        const problem = btcDestinationProblem(chain, destination);
        if (problem) return fail('INVALID_RECORD', problem);
      }
      normalizedDestination = normalizeAddress(chain, destination);
    }
  }

  const record: OperationRecord = {
    kind: kind as OperationKind,
    chain,
    asset: asset === NATIVE_ASSET ? asset : normalizeAddress(chain, asset),
    amount,
    destination: normalizedDestination,
  };
  if (raw !== undefined) record.raw = raw as Record<string, unknown>;
  if (parsedPayee) record.payee = parsedPayee;
  return { ok: true, record, amount: value };
}

/** The record without `raw` (opaque, possibly large): what the audit log and a decision keep, with raw's digest beside it. */
export function recordForAudit(record: OperationRecord): Omit<OperationRecord, 'raw'> {
  const { raw: _raw, ...rest } = record;
  return rest;
}
