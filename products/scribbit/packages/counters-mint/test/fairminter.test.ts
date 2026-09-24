import { describe, expect, it } from 'vitest';
import { fairminterComposeParams, fairminterProblems, type FairminterParams } from '../src/fairminter.js';
import { XCP69, XCP69_TEMPLATE, isXcp69Conformant, matchesXcp69Template, xcp69ComposeParams, xcp69Params, xcp69Schedule } from '../src/xcp69.js';

const base: FairminterParams = {
  lotPrice: 0n,
  lotSize: 1n,
  hardCap: 0n,
  softCap: 0n,
  poolQuantity: 0n,
  maxMintPerTx: 100n,
  maxMintPerAddress: 0n,
  premintQuantity: 0n,
  mintedAssetCommission: 0,
  burnPayment: false,
  lockQuantity: false,
  lockDescription: false,
  divisible: true,
  startBlock: 0,
  endBlock: 0,
  softCapDeadlineBlock: 0,
};

describe('fairminterProblems', () => {
  it('accepts a free open-ended mint and the XCP-69 preset', () => {
    expect(fairminterProblems(base)).toEqual([]);
    expect(fairminterProblems(XCP69)).toEqual([]);
    expect(fairminterProblems(xcp69Params(1_000_000))).toEqual([]);
  });

  it('reports every problem in the order Core would find them', () => {
    expect(fairminterProblems({ ...base, lotSize: 0n })).toEqual(['lot size must be positive']);
    expect(fairminterProblems({ ...base, hardCap: -1n })).toEqual(['quantities cannot be negative']);
    expect(fairminterProblems({ ...base, hardCap: 10n, softCap: 20n, softCapDeadlineBlock: 5 })).toEqual(['soft cap cannot exceed hard cap']);
    expect(fairminterProblems({ ...base, softCap: 5n })).toEqual(['a soft cap needs a deadline block']);
    expect(fairminterProblems({ ...base, softCap: 5n, startBlock: 100, softCapDeadlineBlock: 100 })).toEqual(['the soft cap deadline must be after the start block']);
    expect(fairminterProblems({ ...base, poolQuantity: 5n })).toEqual(['a pool needs a soft cap to open at']);
    expect(fairminterProblems({ ...base, poolQuantity: 5n, softCap: 6n, hardCap: 10n, softCapDeadlineBlock: 9 })).toEqual(['pool reserve plus soft cap cannot exceed the hard cap']);
    expect(fairminterProblems({ ...base, poolQuantity: 5n, softCap: 5n, hardCap: 10n, softCapDeadlineBlock: 9, burnPayment: true })).toEqual(['a pool launch cannot burn the payment — the XCP seeds the pool']);
    expect(fairminterProblems({ ...base, mintedAssetCommission: 1 })).toEqual(['commission is a fraction below 1']);
    expect(fairminterProblems({ ...base, startBlock: 10, endBlock: 10 })).toEqual(['the end block must be after the start block']);
  });
});

describe('XCP-69', () => {
  it('schedules from the tip with the 1,000-block window and a minimum lead of 1', () => {
    expect(xcp69Schedule(961_000, 3)).toEqual({ startBlock: 961_003, deadlineBlock: 962_003 });
    expect(xcp69Schedule(961_000, 0)).toEqual({ startBlock: 961_001, deadlineBlock: 962_001 });
    expect(xcp69Schedule(961_000)).toEqual({ startBlock: 961_003, deadlineBlock: 962_003 });
  });

  it('composes exactly the template with the node\'s current parameter names', () => {
    const params = xcp69ComposeParams({ asset: 'MEMENOME', startBlock: 961_003, lpAsset: 'A95428956661682177' });
    expect(params).toEqual({
      asset: 'MEMENOME',
      lot_price: '1000000',
      lot_size: '100000000000',
      hard_cap: '10000000000000000',
      soft_cap: '6900000000000000',
      pool_quantity: '3100000000000000',
      max_mint_per_tx: '100000000000000',
      max_mint_per_address: '100000000000000',
      premint_quantity: '0',
      minted_asset_commission: '0',
      burn_payment: 'false',
      lock_quantity: 'true',
      lock_description: 'true',
      divisible: 'true',
      start_block: '961003',
      end_block: '0',
      soft_cap_deadline_block: '962003',
      lp_asset: 'A95428956661682177',
    });
    // Caps balance: hard = premint + pool + soft.
    expect(XCP69_TEMPLATE.hard_cap).toBe(XCP69_TEMPLATE.premint_quantity + XCP69_TEMPLATE.pool_quantity + XCP69_TEMPLATE.soft_cap);
    expect(fairminterComposeParams(base, 'X').lp_asset).toBeUndefined();
  });

  it('recognises a conforming launch and names what is off', () => {
    const shape = {
      price: '1000000',
      quantity_by_price: 100_000_000_000,
      hard_cap: '10000000000000000',
      soft_cap: '6900000000000000',
      pool_quantity: '3100000000000000',
      premint_quantity: 0,
      max_mint_per_address: 100_000_000_000_000,
      max_mint_per_tx: 100_000_000_000_000,
      divisible: true,
      lock_quantity: true,
      lock_description: true,
      burn_payment: false,
      start_block: 961_003,
      soft_cap_deadline_block: 962_003,
      block_index: 961_000,
    };
    expect(matchesXcp69Template(shape)).toBe(true);
    expect(isXcp69Conformant(shape)).toEqual({ ok: true, problems: [] });
    expect(isXcp69Conformant({ ...shape, block_index: 961_003 }).problems).toEqual(['start_block']);
    expect(isXcp69Conformant({ ...shape, soft_cap: '6900000000000001' }).problems).toEqual(['template']);
    expect(isXcp69Conformant({ ...shape, soft_cap_deadline_block: 962_004, lock_quantity: false }).problems).toEqual(['lock_quantity', 'window']);
  });
});
