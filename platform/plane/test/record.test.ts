import { describe, expect, it } from 'vitest';
import { BTC_MAX_SATS, normalizeAddress, parseOperationRecord, recordForAudit } from '../src/record.ts';
import { MAIN_P2TR, MAIN_P2WPKH, MAIN_P2WSH, SIGNET_P2TR, SIGNET_P2WSH, TEST_P2WPKH, transfer } from './helpers.ts';

const code = (v: unknown) => {
  const r = parseOperationRecord(v);
  return r.ok ? 'OK' : r.code;
};

describe('OperationRecord (FlashyOS operation-record.json)', () => {
  it('accepts a transfer and returns the amount as a BigInt', () => {
    const r = parseOperationRecord(transfer(25_000));
    expect(r).toEqual({ ok: true, record: { kind: 'transfer', chain: 'btc:mainnet', asset: 'native', amount: '25000', destination: MAIN_P2WPKH }, amount: 25_000n });
  });
  it('INVALID_RECORD for shape problems: not an object, unknown member, missing field, bad kind, bad chain, empty asset', () => {
    expect(code(null)).toBe('INVALID_RECORD');
    expect(code([transfer(1)])).toBe('INVALID_RECORD');
    expect(code({ ...transfer(1), memo: 'x' })).toBe('INVALID_RECORD');
    const { destination: _d, ...noDest } = transfer(1);
    expect(code(noDest)).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { kind: 'mint' }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { chain: 'bitcoin' }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { chain: 'doge:main' }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { asset: '' }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { raw: 'call' }))).toBe('INVALID_RECORD');
  });
  it('INVALID_AMOUNT for negative, fractional, non-numeric, padded, numeric-typed and above-supply amounts', () => {
    for (const amount of ['-1', '1.5', 'abc', '01', ' 1', '1e3', '']) expect(code(transfer(0, MAIN_P2WPKH, { amount }))).toBe('INVALID_AMOUNT');
    expect(code({ ...transfer(0), amount: 25 })).toBe('INVALID_AMOUNT');
    expect(code(transfer((BTC_MAX_SATS + 1n).toString()))).toBe('INVALID_AMOUNT');
    expect(code(transfer(BTC_MAX_SATS.toString()))).toBe('OK');
    expect(code(transfer(0))).toBe('OK');
    // outside btc: no supply rule, BigInt all the way
    expect(code({ kind: 'transfer', chain: 'evm:8453', asset: 'native', amount: '1'.padEnd(40, '0'), destination: '0xabc' })).toBe('OK');
  });
  it('destination null only for a swap; a bridge names <targetChain>:<recipient>', () => {
    expect(code(transfer(1, null as unknown as string))).toBe('INVALID_RECORD');
    expect(code({ kind: 'swap', chain: 'btc:mainnet', asset: 'native', amount: '1', destination: null })).toBe('OK');
    expect(code({ kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '1', destination: '0xabc' })).toBe('INVALID_RECORD');
    expect(code({ kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '1', destination: 'evm:42161:0xABC' })).toBe('OK');
    expect(code({ kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '1', destination: `btc:mainnet:${MAIN_P2TR}` })).toBe('OK');
    expect(code({ kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '1', destination: `btc:mainnet:${TEST_P2WPKH}` })).toBe('INVALID_RECORD');
    expect(code(transfer(1, ''))).toBe('INVALID_RECORD');
  });
  it('payee (ours) is { kind, ref } with a ledger payee kind', () => {
    expect(parseOperationRecord(transfer(1, MAIN_P2WPKH, { payee: { kind: 'artist', ref: 'a-1' } }))).toMatchObject({ ok: true, record: { payee: { kind: 'artist', ref: 'a-1' } } });
    expect(code(transfer(1, MAIN_P2WPKH, { payee: { kind: 'friend', ref: 'a' } }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { payee: { kind: 'artist', ref: '' } }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { payee: { kind: 'artist', ref: 'x'.repeat(129) } }))).toBe('INVALID_RECORD');
    expect(code(transfer(1, MAIN_P2WPKH, { payee: { kind: 'artist', ref: 'a', extra: 1 } }))).toBe('INVALID_RECORD');
  });
  it('normalises: bech32 and evm addresses lowercase, other families byte-exact, "native" kept; raw dropped for audit', () => {
    const r = parseOperationRecord(transfer(1, MAIN_P2WPKH.toUpperCase(), { raw: { tool: 'x' } }));
    expect(r.ok && r.record.destination).toBe(MAIN_P2WPKH);
    expect(r.ok && recordForAudit(r.record)).toEqual({ kind: 'transfer', chain: 'btc:mainnet', asset: 'native', amount: '1', destination: MAIN_P2WPKH });
    expect(normalizeAddress('evm:1', '0xABcD')).toBe('0xabcd');
    expect(normalizeAddress('solana:mainnet', 'AbC')).toBe('AbC');
    const e = parseOperationRecord({ kind: 'transfer', chain: 'evm:1', asset: '0xA0B8', amount: '1', destination: '0x7F3C' });
    expect(e.ok && [e.record.asset, e.record.destination]).toEqual(['0xa0b8', '0x7f3c']);
  });
});

describe('btc destinations (ours: @bsh/mesh bech32/bech32m checker)', () => {
  const valid: [string, string][] = [
    ['btc:mainnet', MAIN_P2WPKH],
    ['btc:mainnet', MAIN_P2WPKH.toUpperCase()],
    ['btc:mainnet', MAIN_P2WSH],
    ['btc:mainnet', MAIN_P2TR],
    ['btc:testnet', TEST_P2WPKH],
    ['btc:signet', SIGNET_P2WSH],
    ['btc:signet', SIGNET_P2TR],
    ['btc:signet', TEST_P2WPKH],
  ];
  const invalid: [string, string, string][] = [
    ['btc:mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bad checksum'],
    ['btc:mainnet', TEST_P2WPKH, 'testnet address on mainnet'],
    ['btc:testnet', MAIN_P2WPKH, 'mainnet address on testnet'],
    ['btc:signet', MAIN_P2TR, 'mainnet taproot on signet'],
    ['btc:mainnet', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', 'v1 with a bech32 (not bech32m) checksum'],
    ['btc:mainnet', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'v0 with a bech32m checksum'],
    ['btc:testnet', 'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', 'v0 bech32m on testnet'],
    ['btc:mainnet', 'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'character outside the charset'],
    ['btc:mainnet', 'bc1gmk9yu', 'empty data'],
    ['btc:mainnet', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'legacy base58 is not segwit'],
    ['btc:mainnet', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mixed case'],
    ['btc:regtest', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'a btc chain this package does not define'],
  ];
  it.each(valid)('%s accepts %s', (chain, address) => {
    expect(code(transfer(1, address, { chain }))).toBe('OK');
  });
  it.each(invalid)('%s refuses %s (%s)', (chain, address) => {
    const r = parseOperationRecord(transfer(1, address, { chain }));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_RECORD' });
  });
});
