// Conformance against FlashyOS's own published schemas (flashyos-wdk docs/wallet/schema,
// vendored unmodified under test/fixtures/flashyos-wdk with a NOTICE). A difference not
// listed in that NOTICE is a bug here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { parseEnvelopeInput } from '../src/envelope.ts';
import { parseOperationRecord } from '../src/record.ts';
import { PLANE_SCHEMAS, type VerdictBody } from '../src/service.ts';
import { harness, MAIN_P2TR, MAIN_P2WPKH, transfer } from './helpers.ts';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/flashyos-wdk/${name}`, import.meta.url), 'utf8')) as { $id: string };
const schemas = ['operation-record.json', 'spend-authorization.json', 'spend-envelope-input.json', 'verdict.json'].map(load);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
for (const s of schemas) ajv.addSchema(s);
const theirs = (id: string) => {
  const v = ajv.getSchema(`https://flashyos.com/schema/wallet/${id}`);
  if (!v) throw new Error(id);
  return (value: unknown) => v(value) as boolean;
};
const opRecord = theirs('operation-record.json');
const authorization = theirs('spend-authorization.json');
const envelopeInput = theirs('spend-envelope-input.json');
const verdict = theirs('verdict.json');

describe('the plane document advertises only schemas that are actually vendored and enforced', () => {
  it('every $id listed is one of FlashyOS\'s', () => {
    const ids = schemas.map((s) => s.$id);
    for (const id of PLANE_SCHEMAS) expect(ids).toContain(id);
  });
});

describe('OperationRecord: we accept what they accept, refuse what they refuse (except where marked)', () => {
  const both = [
    transfer(25_000),
    { kind: 'swap', chain: 'btc:mainnet', asset: 'native', amount: '1', destination: null },
    { kind: 'meter', chain: 'evm:8453', asset: '0xA0B8', amount: '0', destination: '0x7F3C', raw: { tool: 'x' } },
    { kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '5', destination: 'evm:42161:0xabc' },
    { kind: 'transfer', chain: 'solana:mainnet', asset: 'native', amount: '7', destination: 'So1ana' },
  ];
  const neither = [
    { ...transfer(1), amount: '-1' },
    { ...transfer(1), amount: '1.0' },
    { ...transfer(1), amount: 1 },
    { ...transfer(1), kind: 'mint' },
    { ...transfer(1), chain: 'bitcoin' },
    { ...transfer(1), asset: '' },
    { ...transfer(1), destination: null },
    { ...transfer(1), destination: '' },
    { ...transfer(1), memo: 'x' },
    { kind: 'bridge', chain: 'evm:8453', asset: 'native', amount: '5', destination: '0xabc' },
    { kind: 'transfer', chain: 'btc:mainnet', asset: 'native', amount: '1' },
  ];
  it.each(both.map((r) => [JSON.stringify(r).slice(0, 70), r]))('both accept %s', (_l, r) => {
    expect(opRecord(r)).toBe(true);
    expect(parseOperationRecord(r).ok).toBe(true);
  });
  it.each(neither.map((r) => [JSON.stringify(r).slice(0, 70), r]))('both refuse %s', (_l, r) => {
    expect(opRecord(r)).toBe(false);
    expect(parseOperationRecord(r).ok).toBe(false);
  });
  it('marked differences: a btc destination that is not a segwit address (ours refuses), and `payee` (ours accepts)', () => {
    const notAddress = transfer(1, 'definitely-not-bech32');
    expect([opRecord(notAddress), parseOperationRecord(notAddress).ok]).toEqual([true, false]);
    const withPayee = transfer(1, MAIN_P2TR, { payee: { kind: 'artist', ref: 'ada' } });
    expect([opRecord(withPayee), parseOperationRecord(withPayee).ok]).toEqual([false, true]);
    const { payee: _p, ...stripped } = withPayee as Record<string, unknown>;
    expect(opRecord(stripped)).toBe(true);
  });
});

describe('SpendEnvelopeInput: every input they accept (without delegation) is accepted', () => {
  const inputs = [
    { chain: 'btc:mainnet', kinds: ['transfer'], assets: ['native'], destinations: [MAIN_P2WPKH], perTxMax: '1', dailyMax: '2', autoApproveMax: '0' },
    { chain: 'btc:signet', kinds: ['transfer', 'swap'], assets: ['native'], destinations: [], perTxMax: '1', dailyMax: '2', autoApproveMax: '0', alwaysEscalate: true, escalationImpact: 'CRITICAL', delegable: false },
  ];
  it.each(inputs.map((i) => [i.chain, i]))('%s', (_c, input) => {
    expect(envelopeInput(input)).toBe(true);
    expect(parseEnvelopeInput(input).ok).toBe(true);
  });
  it('delegable: true is theirs, refused here (not implemented)', () => {
    const d = { ...inputs[0], delegable: true };
    expect([envelopeInput(d), parseEnvelopeInput(d).ok]).toEqual([true, false]);
  });
});

describe('what the plane emits validates under their schemas', () => {
  const strip = (v: VerdictBody): Record<string, unknown> => {
    const { reasons: _r, replayed: _p, ...rest } = v as VerdictBody & { replayed?: true };
    if (rest.verdict === 'ALLOW') {
      const { impact: _i, ...allow } = rest;
      return allow;
    }
    if (rest.verdict === 'DENY') {
      const { decisionId: _d, ...deny } = rest;
      return deny;
    }
    return rest;
  };
  it('a signed SpendAuthorization, and ALLOW / ESCALATE / DENY verdicts minus our members', async () => {
    const h = harness();
    await h.setEnvelope();
    const allow = await h.propose(transfer(25_000));
    const escalate = await h.propose(transfer(60_000));
    const deny = await h.propose(transfer(1, MAIN_P2WPKH, { kind: 'meter' }));
    expect(allow.verdict === 'ALLOW' && authorization(allow.authorization)).toBe(true);
    for (const v of [allow, escalate, deny]) expect(verdict(strip(v))).toBe(true);
    // and with our members left in, their closed schema refuses them - which is why the NOTICE lists them
    expect(verdict(deny)).toBe(false);
  });
});
