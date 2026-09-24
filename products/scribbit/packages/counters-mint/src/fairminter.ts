/**
 * Fairminter deploys, as they matter to a counter mint.
 *
 * A fairminter deploy that carries its file in a taproot envelope is both a
 * launch and a numbered Counter (build reference v3 R2). With
 * `pool_quantity > 0` it is a *pool fairminter* (Core v11.2, `fairmint_pool`
 * gate, mainnet block 961,100): at soft cap consensus pairs `pool_quantity`
 * of the minted asset with every raised XCP, opens the TOKEN/XCP pool, and
 * mints the LP tokens to the unspendable address.
 *
 * Ported from counters.fun `packages/counters/src/fairminter.ts` (the compose
 * half; the display helpers stay there).
 */

import { type CborValue } from './cbor.js';

export const FAIRMINT_POOL_ACTIVATION_BLOCK = 961_100;

/**
 * Everything `compose/fairminter` takes that shapes the sale, in raw units.
 * XCP-69 is one fixed instance of this (see ./xcp69); a custom deploy is any
 * other. Zero means "none" wherever Core reads it that way: no soft cap, no
 * pool, no per-address cap, no end block.
 */
export interface FairminterParams {
  /** Raw XCP per lot. 0 makes the mint free, and `maxMintPerTx` the amount per mint. */
  lotPrice: bigint;
  /** Raw tokens per lot. */
  lotSize: bigint;
  hardCap: bigint;
  softCap: bigint;
  /** Raw tokens reserved for the AMM pool, paired with all raised XCP at soft cap. */
  poolQuantity: bigint;
  maxMintPerTx: bigint;
  maxMintPerAddress: bigint;
  premintQuantity: bigint;
  /** Fraction of each mint paid to the issuer, 0–1. */
  mintedAssetCommission: number;
  burnPayment: boolean;
  lockQuantity: boolean;
  lockDescription: boolean;
  divisible: boolean;
  /** 0 opens the sale in the deploy's own block. */
  startBlock: number;
  /** 0 for no end. */
  endBlock: number;
  /** Required when `softCap` > 0. */
  softCapDeadlineBlock: number;
  /** Numeric asset for the LP token; drawn when empty. Only meaningful with a pool. */
  lpAsset?: string;
}

/** Why a set of parameters cannot be composed, in the order Core would find them. */
export function fairminterProblems(p: FairminterParams): string[] {
  const problems: string[] = [];
  if (p.lotSize <= 0n) problems.push('lot size must be positive');
  if (p.hardCap < 0n || p.softCap < 0n || p.poolQuantity < 0n || p.premintQuantity < 0n) problems.push('quantities cannot be negative');
  if (p.softCap > 0n && p.hardCap > 0n && p.softCap > p.hardCap) problems.push('soft cap cannot exceed hard cap');
  if (p.softCap > 0n && p.softCapDeadlineBlock <= 0) problems.push('a soft cap needs a deadline block');
  if (p.softCap > 0n && p.startBlock > 0 && p.softCapDeadlineBlock <= p.startBlock) problems.push('the soft cap deadline must be after the start block');
  if (p.poolQuantity > 0n && p.softCap <= 0n) problems.push('a pool needs a soft cap to open at');
  if (p.poolQuantity > 0n && p.hardCap > 0n && p.poolQuantity + p.softCap > p.hardCap) problems.push('pool reserve plus soft cap cannot exceed the hard cap');
  if (p.poolQuantity > 0n && p.burnPayment) problems.push('a pool launch cannot burn the payment — the XCP seeds the pool');
  if (p.mintedAssetCommission < 0 || p.mintedAssetCommission >= 1) problems.push('commission is a fraction below 1');
  if (p.endBlock > 0 && p.startBlock > 0 && p.endBlock <= p.startBlock) problems.push('the end block must be after the start block');
  return problems;
}

/** The compose parameters, by the node's current names. */
export function fairminterComposeParams(p: FairminterParams, asset: string): Record<string, string> {
  const out: Record<string, string> = {
    asset,
    lot_price: p.lotPrice.toString(),
    lot_size: p.lotSize.toString(),
    hard_cap: p.hardCap.toString(),
    soft_cap: p.softCap.toString(),
    pool_quantity: p.poolQuantity.toString(),
    max_mint_per_tx: p.maxMintPerTx.toString(),
    max_mint_per_address: p.maxMintPerAddress.toString(),
    premint_quantity: p.premintQuantity.toString(),
    minted_asset_commission: String(p.mintedAssetCommission),
    burn_payment: String(p.burnPayment),
    lock_quantity: String(p.lockQuantity),
    lock_description: String(p.lockDescription),
    divisible: String(p.divisible),
    start_block: String(p.startBlock),
    end_block: String(p.endBlock),
    soft_cap_deadline_block: String(p.softCapDeadlineBlock),
  };
  if (p.lpAsset) out.lp_asset = p.lpAsset;
  return out;
}

/**
 * The CBOR fields of a fairminter message before `mime_type` and the content
 * (`messages/fairminter.py`, `fairminter_v2`). Used only to size the envelope.
 */
export function fairminterMessageFields(p: FairminterParams, assetIdValue: bigint, assetParentId: bigint): CborValue[] {
  return [
    assetIdValue,
    assetParentId,
    p.lotPrice,
    p.lotSize,
    p.maxMintPerTx,
    p.maxMintPerAddress,
    p.hardCap,
    p.premintQuantity,
    p.startBlock,
    p.endBlock,
    p.softCap,
    p.softCapDeadlineBlock,
    BigInt(Math.round(p.mintedAssetCommission * 1e8)),
    p.burnPayment,
    p.lockDescription,
    p.lockQuantity,
    p.divisible,
  ];
}
