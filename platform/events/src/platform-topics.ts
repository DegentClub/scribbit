import type { JsonSchema } from './schema.js';
import { defineTopic, TopicRegistry } from './topics.js';

/**
 * Platform topic catalogue. MUST agree with contracts/asyncapi/platform-events.yaml (enforced by
 * test/asyncapi.test.ts): same channel addresses, parameters, payload schemas, versions and producers.
 * Contract first: edit the YAML, then mirror it here.
 */
export const CONTRACT_PATH = 'contracts/asyncapi/platform-events.yaml';
const SCHEMA_BASE = `https://blockspace.holdings/${CONTRACT_PATH}#/components/schemas/`;

/** CloudEvents `source` for a component: `urn:bsh:<component-name>`. */
export const sourceFor = (component: string): string => `urn:bsh:${component}`;

export const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'] as const;
export type Network = (typeof NETWORKS)[number];

export const MINT_ORDER_STATUSES = [
  'awaiting_content',
  'reviewing',
  'approved',
  'rejected',
  'awaiting_payment',
  'paid',
  'queued',
  'revealing',
  'revealed',
  'confirmed',
  'verified',
  'delivered',
  'expired',
  'rescue_available',
  'failed',
] as const;
export type MintOrderStatus = (typeof MINT_ORDER_STATUSES)[number];

export const BATCH_STATUSES = ['created', 'funded', 'committed', 'revealed', 'confirmed', 'failed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

const hex64 = { type: 'string', pattern: '^[0-9a-f]{64}$' } satisfies JsonSchema;
const inscriptionId = { type: 'string', pattern: '^[0-9a-f]{64}i[0-9]+$' } satisfies JsonSchema;
const network = { type: 'string', enum: [...NETWORKS] } satisfies JsonSchema;
const dateTime = { type: 'string', format: 'date-time' } satisfies JsonSchema;
const networkParam = { description: 'Bitcoin network (testnet = testnet4).', enum: NETWORKS };

// ------------------------------------------------------------------------------------ block.indexed.{network}

export interface BlockIndexed {
  network: Network;
  height: number;
  hash: string;
  previousHash: string;
  time: string;
  txCount?: number;
  reorgDepth?: number;
}

export const blockIndexed = defineTopic<BlockIndexed>({
  name: 'block.indexed.{network}',
  version: '1.0.0',
  producer: 'bitcoin-indexer',
  description: 'A block has been fully indexed at the tip of the given network. Re-emitted for replacement blocks after a reorg.',
  params: { network: networkParam },
  dataschema: `${SCHEMA_BASE}BlockIndexed`,
  schema: {
    type: 'object',
    required: ['network', 'height', 'hash', 'previousHash', 'time'],
    properties: {
      network,
      height: { type: 'integer', minimum: 0 },
      hash: hex64,
      previousHash: hex64,
      time: { ...dateTime, description: 'Block header time.' },
      txCount: { type: 'integer', minimum: 1 },
      reorgDepth: { type: 'integer', minimum: 0, description: 'Blocks replaced by this one (0 or absent = no reorg).' },
    },
  },
});

// ------------------------------------------------------------------------------------ collection.*

export interface CollectionMinted {
  collectionId: string;
  network: Network;
  inscriptionId: string;
  parentInscriptionId?: string;
  txid: string;
  orderId?: string;
  contentHash?: string;
  mintedAt: string;
}

export const collectionMinted = defineTopic<CollectionMinted>({
  name: 'collection.minted',
  version: '1.0.0',
  producer: 'degent-mint',
  description: 'An inscription belonging to a collection has been revealed on chain (confirmed).',
  dataschema: `${SCHEMA_BASE}CollectionMinted`,
  schema: {
    type: 'object',
    required: ['collectionId', 'network', 'inscriptionId', 'txid', 'mintedAt'],
    properties: {
      collectionId: { type: 'string', minLength: 1, maxLength: 128 },
      network,
      inscriptionId,
      parentInscriptionId: inscriptionId,
      txid: hex64,
      orderId: { type: 'string', minLength: 1 },
      contentHash: { ...hex64, description: 'SHA-256 of the inscription content.' },
      mintedAt: dateTime,
    },
  },
});

export interface CollectionCertified {
  collectionId: string;
  network: Network;
  parentInscriptionId: string;
  checks: Array<'parent_link' | 'content_hash'>;
  inscriptionCount?: number;
  certifiedAt: string;
}

export const collectionCertified = defineTopic<CollectionCertified>({
  name: 'collection.certified',
  version: '1.0.0',
  producer: 'blockspace-certify',
  description: 'A collection passed provenance certification (parent/child links and optional content hashes).',
  dataschema: `${SCHEMA_BASE}CollectionCertified`,
  schema: {
    type: 'object',
    required: ['collectionId', 'network', 'parentInscriptionId', 'checks', 'certifiedAt'],
    properties: {
      collectionId: { type: 'string', minLength: 1, maxLength: 128 },
      network,
      parentInscriptionId: inscriptionId,
      checks: { type: 'array', minItems: 1, items: { type: 'string', enum: ['parent_link', 'content_hash'] } },
      inscriptionCount: { type: 'integer', minimum: 0 },
      certifiedAt: dateTime,
    },
  },
});

// ------------------------------------------------------------------------------------ degent.mint.order.{status}

export interface MintOrderStatusChanged {
  type: string;
  eventId: string;
  orderId: string;
  network: Network;
  status: MintOrderStatus;
  previousStatus: MintOrderStatus | null;
  at: string;
  lane: 'standard' | 'block';
  detail?: string;
  txid?: string;
  inscriptionId?: string;
}

export const degentMintOrder = defineTopic<MintOrderStatusChanged>({
  name: 'degent.mint.order.{status}',
  version: '1.0.0',
  producer: 'degent-mint',
  description:
    'A degent.club mint order changed status. This schema is canonical for the shared topic; the producer\'s own OrderStatusEvent (contracts/asyncapi/degent-mint.yaml in DegentClub/degent) must stay compatible with it. On this bus it travels as CloudEvents `data`.',
  params: { status: { description: 'The status the order moved to.', enum: MINT_ORDER_STATUSES } },
  dataschema: `${SCHEMA_BASE}MintOrderStatusChanged`,
  schema: {
    type: 'object',
    required: ['type', 'eventId', 'orderId', 'network', 'status', 'previousStatus', 'at', 'lane'],
    properties: {
      type: { type: 'string', pattern: '^degent\\.mint\\.order\\.[a-z_]+$' },
      eventId: { type: 'string', minLength: 1, description: '`<orderId>:<timeline index>`; stable across redeliveries.' },
      orderId: { type: 'string', minLength: 1 },
      network,
      status: { type: 'string', enum: [...MINT_ORDER_STATUSES] },
      previousStatus: { type: ['string', 'null'], enum: [...MINT_ORDER_STATUSES, null] },
      at: dateTime,
      lane: { type: 'string', enum: ['standard', 'block'] },
      detail: { type: 'string' },
      txid: hex64,
      inscriptionId,
    },
  },
});

// ------------------------------------------------------------------------------------ batch.{status}

export interface BatchStatusChanged {
  batchId: string;
  network: Network;
  status: BatchStatus;
  previousStatus: BatchStatus | null;
  at: string;
  orderCount: number;
  feeSats?: number;
  txids?: string[];
  detail?: string;
}

export const batchStatus = defineTopic<BatchStatusChanged>({
  name: 'batch.{status}',
  version: '1.0.0',
  producer: 'scribbit-ledger',
  description: 'A scribb.it inscription batch changed status in the ledger.',
  params: { status: { description: 'The status the batch moved to.', enum: BATCH_STATUSES } },
  dataschema: `${SCHEMA_BASE}BatchStatusChanged`,
  schema: {
    type: 'object',
    required: ['batchId', 'network', 'status', 'previousStatus', 'at', 'orderCount'],
    properties: {
      batchId: { type: 'string', minLength: 1 },
      network,
      status: { type: 'string', enum: [...BATCH_STATUSES] },
      previousStatus: { type: ['string', 'null'], enum: [...BATCH_STATUSES, null] },
      at: dateTime,
      orderCount: { type: 'integer', minimum: 0 },
      feeSats: { type: 'integer', minimum: 0 },
      txids: { type: 'array', items: hex64 },
      detail: { type: 'string' },
    },
  },
});

// ------------------------------------------------------------------------------------ ledger.order.{status} / ledger.payment.{status}

export const LEDGER_PRODUCTS = ['blockspace', 'scribbit', 'degent'] as const;
export type LedgerProduct = (typeof LEDGER_PRODUCTS)[number];

export const LEDGER_ORDER_STATUSES = ['created', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded'] as const;
export type LedgerOrderStatus = (typeof LEDGER_ORDER_STATUSES)[number];

export const LEDGER_PAYMENT_STATUSES = ['created', 'pending', 'paid', 'underpaid', 'overpaid', 'expired', 'failed', 'refunded'] as const;
export type LedgerPaymentStatus = (typeof LEDGER_PAYMENT_STATUSES)[number];

export const LEDGER_PAYMENT_METHODS = ['onchain', 'lightning', 'card', 'psbt'] as const;
export type LedgerPaymentMethod = (typeof LEDGER_PAYMENT_METHODS)[number];

export const LEDGER_PAYOUT_STATUSES = ['settled', 'pending', 'failed'] as const;
export type LedgerPayoutStatus = (typeof LEDGER_PAYOUT_STATUSES)[number];

export const LEDGER_PAYEE_KINDS = ['artist', 'club', 'platform', 'other'] as const;
export type LedgerPayeeKind = (typeof LEDGER_PAYEE_KINDS)[number];

const ledgerProduct = { type: 'string', enum: [...LEDGER_PRODUCTS] } satisfies JsonSchema;
const sats = { type: 'integer', minimum: 0, maximum: 2100000000000000 } satisfies JsonSchema;

export interface LedgerOrderStatusChanged {
  orderId: string;
  product: LedgerProduct;
  customerRef: string;
  status: LedgerOrderStatus;
  previousStatus: LedgerOrderStatus | null;
  currency: 'sat';
  totalSats: number;
  at: string;
  detail?: string;
}

export const ledgerOrderStatus = defineTopic<LedgerOrderStatusChanged>({
  name: 'ledger.order.{status}',
  version: '1.0.0',
  producer: 'ledger',
  description: 'An order in the shared ledger changed status. Amounts are integer satoshis.',
  params: { status: { description: 'The status the order moved to.', enum: LEDGER_ORDER_STATUSES } },
  dataschema: `${SCHEMA_BASE}LedgerOrderStatusChanged`,
  schema: {
    type: 'object',
    required: ['orderId', 'product', 'customerRef', 'status', 'previousStatus', 'currency', 'totalSats', 'at'],
    properties: {
      orderId: { type: 'string', minLength: 1 },
      product: ledgerProduct,
      customerRef: { type: 'string', minLength: 1, maxLength: 256, description: 'Opaque reference owned by the product; never PII.' },
      status: { type: 'string', enum: [...LEDGER_ORDER_STATUSES] },
      previousStatus: { type: ['string', 'null'], enum: [...LEDGER_ORDER_STATUSES, null] },
      currency: { const: 'sat' },
      totalSats: sats,
      at: dateTime,
      detail: { type: 'string' },
    },
  },
});

export interface LedgerPaymentStatusChanged {
  paymentId: string;
  orderId: string;
  product: LedgerProduct;
  method: LedgerPaymentMethod;
  provider: string;
  status: LedgerPaymentStatus;
  previousStatus: LedgerPaymentStatus | null;
  amountSats: number;
  amountPaidSats: number;
  at: string;
  paidAt?: string;
  txid?: string;
  detail?: string;
}

export const ledgerPaymentStatus = defineTopic<LedgerPaymentStatusChanged>({
  name: 'ledger.payment.{status}',
  // 1.1.0: `method` gained `psbt` (additive: enum values may be added within a major).
  version: '1.1.0',
  producer: 'ledger',
  description: 'A payment intent in the shared ledger changed status (on-chain, Lightning via BTCPay, card, or a product-built PSBT). Amounts are integer satoshis.',
  params: { status: { description: 'The status the payment moved to.', enum: LEDGER_PAYMENT_STATUSES } },
  dataschema: `${SCHEMA_BASE}LedgerPaymentStatusChanged`,
  schema: {
    type: 'object',
    required: ['paymentId', 'orderId', 'product', 'method', 'provider', 'status', 'previousStatus', 'amountSats', 'amountPaidSats', 'at'],
    properties: {
      paymentId: { type: 'string', minLength: 1 },
      orderId: { type: 'string', minLength: 1 },
      product: ledgerProduct,
      method: { type: 'string', enum: [...LEDGER_PAYMENT_METHODS] },
      provider: { type: 'string', minLength: 1, description: 'Provider adapter name (onchain, btcpay, card, psbt, fake).' },
      status: { type: 'string', enum: [...LEDGER_PAYMENT_STATUSES] },
      previousStatus: { type: ['string', 'null'], enum: [...LEDGER_PAYMENT_STATUSES, null] },
      amountSats: sats,
      amountPaidSats: { ...sats, description: 'Satoshis credited so far under the provider\'s confirmation policy.' },
      at: dateTime,
      paidAt: dateTime,
      txid: hex64,
      detail: { type: 'string' },
    },
  },
});

// ------------------------------------------------------------------------------------ ledger.payout.{status}

export interface LedgerPayee {
  kind: LedgerPayeeKind;
  ref: string;
  address?: string;
  scriptHex?: string;
}

export interface LedgerPayoutStatusChanged {
  payoutId: string;
  orderId: string;
  paymentId: string;
  product: LedgerProduct;
  payee: LedgerPayee;
  amountSats: number;
  txid: string;
  vout: number;
  status: LedgerPayoutStatus;
  at: string;
}

export const ledgerPayoutStatus = defineTopic<LedgerPayoutStatusChanged>({
  name: 'ledger.payout.{status}',
  version: '1.0.0',
  producer: 'ledger',
  description: 'Money reached a payee (artist, club, platform...) in the transaction settling a ledger payment; one event per payee output. Amounts are integer satoshis.',
  params: { status: { description: 'The status of the payout.', enum: LEDGER_PAYOUT_STATUSES } },
  dataschema: `${SCHEMA_BASE}LedgerPayoutStatusChanged`,
  schema: {
    type: 'object',
    required: ['payoutId', 'orderId', 'paymentId', 'product', 'payee', 'amountSats', 'txid', 'vout', 'status', 'at'],
    properties: {
      payoutId: { type: 'string', minLength: 1 },
      orderId: { type: 'string', minLength: 1 },
      paymentId: { type: 'string', minLength: 1 },
      product: ledgerProduct,
      payee: {
        type: 'object',
        required: ['kind', 'ref'],
        properties: {
          kind: { type: 'string', enum: [...LEDGER_PAYEE_KINDS] },
          ref: { type: 'string', minLength: 1, maxLength: 128, description: 'Opaque payee reference owned by the product; never PII.' },
          address: { type: 'string', minLength: 1, maxLength: 128 },
          scriptHex: { type: 'string', pattern: '^([0-9a-f]{2})+$', description: 'scriptPubKey the payout was matched on.' },
        },
      },
      amountSats: sats,
      txid: hex64,
      vout: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: [...LEDGER_PAYOUT_STATUSES] },
      at: dateTime,
    },
  },
});

export const PLATFORM_TOPICS = [blockIndexed, collectionMinted, collectionCertified, degentMintOrder, batchStatus, ledgerOrderStatus, ledgerPaymentStatus, ledgerPayoutStatus] as const;

/** Fresh registry pre-loaded with every platform topic. */
export function platformRegistry(): TopicRegistry {
  return new TopicRegistry(PLATFORM_TOPICS);
}
