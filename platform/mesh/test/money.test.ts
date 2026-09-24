import { describe, expect, it } from 'vitest';
import { generateKeyPair, keyFingerprint } from '../src/keys.ts';
import { BTC_CHAINS, CHAIN_RE, invoiceHash, isBtcChain, receiptFor, signInvoice, type SignedInvoicePayload, type SignedReceiptPayload, signReceipt, validateBtcDestination, verifyInvoice, verifyReceipt } from '../src/money.ts';

const payee = generateKeyPair();
const plane = generateKeyPair();
const NOW = new Date('2026-09-20T10:00:00.000Z');

const invoicePayload: SignedInvoicePayload = {
  version: 1,
  id: 'inv-2026-0042',
  payee: { name: 'Northwind Data Co.', publicKey: payee.publicKey },
  chain: 'evm:84532',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amount: '2500000',
  destination: '0x7f3c000000000000000000000000000000000009',
  memo: 'September dataset licence',
  issuedAt: '2026-09-20T09:00:00.000Z',
  expiresAt: '2026-09-27T09:00:00.000Z',
};

describe('keys', () => {
  it('generates Ed25519 pairs as PEM with a kid that is the sha256 of the SPKI DER, whatever the PEM whitespace', () => {
    expect(payee.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/);
    expect(payee.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(payee.kid).toMatch(/^[0-9a-f]{64}$/);
    expect(keyFingerprint(payee.publicKey)).toBe(payee.kid);
    expect(keyFingerprint(payee.publicKey.replace(/\n/g, '\r\n'))).toBe(payee.kid);
    expect(keyFingerprint(plane.publicKey)).not.toBe(payee.kid);
    expect(() => keyFingerprint('not a pem')).toThrow();
  });
});

describe('SignedInvoice', () => {
  it('verifies under the key it carries, and not after any signed field changes', () => {
    const invoice = signInvoice(invoicePayload, payee.privateKey);
    expect(invoice.sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyInvoice(invoice, NOW)).toEqual({ ok: true });
    expect(verifyInvoice({ ...invoice, amount: '2500001' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, destination: '0x7f3c000000000000000000000000000000000001' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, payee: { ...invoice.payee, publicKey: plane.publicKey } }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
  it('is the same document whatever the key order, and a different hash for a different amount', () => {
    const invoice = signInvoice(invoicePayload, payee.privateKey);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(invoice).reverse()))) as unknown;
    expect(verifyInvoice(reordered, NOW)).toEqual({ ok: true });
    expect(invoiceHash(reordered as SignedInvoicePayload)).toBe(invoiceHash(invoice));
    expect(invoiceHash(invoice)).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceHash({ ...invoicePayload, amount: '1' })).not.toBe(invoiceHash(invoicePayload));
  });
  it('refuses an expired, a not-yet-valid (30 s skew), and a malformed invoice, without throwing', () => {
    const invoice = signInvoice(invoicePayload, payee.privateKey);
    expect(verifyInvoice(invoice, new Date('2026-10-01T00:00:00Z'))).toEqual({ ok: false, code: 'EXPIRED' });
    expect(verifyInvoice(invoice, new Date('2026-09-20T08:00:00Z'))).toEqual({ ok: false, code: 'NOT_YET_VALID' });
    expect(verifyInvoice(invoice, new Date('2026-09-20T08:59:31Z'))).toEqual({ ok: true });
    expect(verifyInvoice(invoice, new Date('2026-09-20T08:59:29Z'))).toEqual({ ok: false, code: 'NOT_YET_VALID' });
    expect(verifyInvoice({ ...invoice, amount: '1.5' }, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice({ ...invoice, amount: '007' }, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice({ ...invoice, chain: 'bitcoin:mainnet' }, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice({ ...invoice, version: 2 }, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice(null, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice({ ...invoice, sig: '!!!' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, payee: { name: 'x', publicKey: 'not a pem' } }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
  it('admits every chain family of the schema regex', () => {
    for (const chain of ['evm:1', 'tron:mainnet', 'ton:-3', 'solana:mainnet-beta', 'btc:signet']) expect(CHAIN_RE.test(chain), chain).toBe(true);
    for (const chain of ['evm', 'evm:', 'sui:1', 'btc:main net']) expect(CHAIN_RE.test(chain), chain).toBe(false);
  });
});

describe('SignedReceipt', () => {
  const invoice = signInvoice(invoicePayload, payee.privateKey);
  const receiptPayload: SignedReceiptPayload = {
    version: 1,
    invoiceId: invoice.id,
    invoiceHash: invoiceHash(invoice),
    payer: { org: 'acme', agentName: 'procurement', publicKey: plane.publicKey },
    payee: invoice.payee,
    chain: invoice.chain,
    asset: invoice.asset,
    amount: invoice.amount,
    destination: invoice.destination,
    txHash: '0xabc',
    outcome: 'CONFIRMED',
    authorizationId: 'auth-1',
    settledAt: '2026-09-20T10:05:00.000Z',
  };
  it('verifies under the plane key the verifier already trusts', () => {
    const receipt = signReceipt(receiptPayload, plane.privateKey);
    expect(verifyReceipt(receipt, { expectedPayerKey: plane.publicKey, invoice })).toEqual({ ok: true });
    expect(verifyReceipt(receipt)).toEqual({ ok: true });
  });
  it('is WRONG_KEY when the embedded key is not the expected one, even if self-consistent', () => {
    const impostor = generateKeyPair();
    const forged = signReceipt({ ...receiptPayload, payer: { ...receiptPayload.payer, publicKey: impostor.publicKey } }, impostor.privateKey);
    expect(verifyReceipt(forged)).toEqual({ ok: true });
    expect(verifyReceipt(forged, { expectedPayerKey: plane.publicKey })).toEqual({ ok: false, code: 'WRONG_KEY' });
    expect(verifyReceipt(forged, { trustedKeys: [plane.publicKey] })).toEqual({ ok: false, code: 'WRONG_KEY' });
    expect(verifyReceipt(forged, { trustedKeys: [plane.publicKey, impostor.publicKey] })).toEqual({ ok: true });
    expect(verifyReceipt(forged, { trustedKeys: [] })).toEqual({ ok: false, code: 'WRONG_KEY' });
  });
  it('fails when the receipt names a different invoice or a field is altered', () => {
    const receipt = signReceipt(receiptPayload, plane.privateKey);
    expect(verifyReceipt(receipt, { invoice: { ...invoicePayload, amount: '9' } })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyReceipt({ ...receipt, txHash: '0xdef' })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyReceipt({ ...receipt, outcome: 'MAYBE' })).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyReceipt({ ...receipt, invoiceHash: 'abc' })).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyReceipt(undefined)).toEqual({ ok: false, code: 'MALFORMED' });
  });
  it('receiptFor copies the invoice\'s money fields and names it by hash', () => {
    const payload = receiptFor(invoice, { payer: receiptPayload.payer, txHash: '0x1', outcome: 'REVERTED', authorizationId: 'a', settledAt: '2026-09-21T00:00:00.000Z' });
    expect(payload).toMatchObject({ invoiceId: invoice.id, invoiceHash: invoiceHash(invoice), chain: invoice.chain, asset: invoice.asset, amount: invoice.amount, destination: invoice.destination, payee: invoice.payee, outcome: 'REVERTED' });
    expect(verifyReceipt(signReceipt(payload, plane.privateKey), { expectedPayerKey: plane.publicKey, invoice })).toEqual({ ok: true });
  });
});

describe('btc: chains (scribbit extension)', () => {
  const MAINNET = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const TESTNET_TR = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
  it('defines mainnet, testnet, testnet4 and signet with their hrps', () => {
    expect(Object.keys(BTC_CHAINS)).toEqual(['btc:mainnet', 'btc:testnet', 'btc:testnet4', 'btc:signet']);
    expect(isBtcChain('btc:signet')).toBe(true);
    expect(isBtcChain('evm:1')).toBe(false);
  });
  it('validates a destination for its network', () => {
    expect(validateBtcDestination('btc:mainnet', MAINNET)).toMatchObject({ ok: true, network: 'mainnet', hrp: 'bc', version: 0 });
    expect(validateBtcDestination('btc:signet', TESTNET_TR)).toMatchObject({ ok: true, network: 'signet', version: 1, encoding: 'bech32m' });
    expect(validateBtcDestination('btc:testnet4', TESTNET_TR)).toMatchObject({ ok: true, network: 'testnet' });
    expect(validateBtcDestination('btc:mainnet', TESTNET_TR)).toMatchObject({ ok: false });
    expect(validateBtcDestination('btc:regtest', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toMatchObject({ ok: false, reason: expect.stringContaining('unknown btc chain') });
    expect(validateBtcDestination('btc:mainnet', 12 as unknown as string)).toMatchObject({ ok: false });
  });
  it('verifyInvoice checks the destination only when asked, and reports BAD_DESTINATION before the signature', () => {
    const good = signInvoice({ ...invoicePayload, chain: 'btc:mainnet', asset: 'native', destination: MAINNET }, payee.privateKey);
    expect(verifyInvoice(good, NOW, { btcDestination: true })).toEqual({ ok: true });
    const wrongNet = signInvoice({ ...invoicePayload, chain: 'btc:mainnet', asset: 'native', destination: TESTNET_TR }, payee.privateKey);
    expect(verifyInvoice(wrongNet, NOW)).toEqual({ ok: true });
    expect(verifyInvoice(wrongNet, NOW, { btcDestination: true })).toMatchObject({ ok: false, code: 'BAD_DESTINATION', detail: expect.stringContaining('mainnet') });
    expect(verifyInvoice({ ...wrongNet, sig: 'bad' }, NOW, { btcDestination: true })).toMatchObject({ ok: false, code: 'BAD_DESTINATION' });
    const evm = signInvoice(invoicePayload, payee.privateKey);
    expect(verifyInvoice(evm, NOW, { btcDestination: true })).toEqual({ ok: true });
  });
});
