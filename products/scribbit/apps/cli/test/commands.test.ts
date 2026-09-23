import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { buildHalfSignedReveal, buildInscriptionScript, buildRescueReveal, commitAddress, inscriptionScriptLength } from '@bsh/inscription';
import { describe, expect, it } from 'vitest';
import { walkScript } from '../src/index.js';
import { bytes, cli, FIXTURES, PARENT_ID } from './helpers.js';

const PRIV = hex.decode('01'.repeat(32));
const PUB = schnorr.getPublicKey(PRIV);
const PUB_HEX = hex.encode(PUB);

describe('scribbit envelope', () => {
  it('summarises chunks and pushes, and --hex equals buildInscriptionScript', async () => {
    const body = bytes(1_041);
    const r = await cli(['envelope', 'x.webp', '--parent', PARENT_ID, '--pubkey', PUB_HEX, '--hex', '--json'], { files: { 'x.webp': body } });
    expect(r.code).toBe(0);
    const e = r.json();
    const script = buildInscriptionScript(PUB, { contentType: 'image/webp', body, parentId: PARENT_ID });
    expect(e.hex).toBe(hex.encode(script));
    expect(e.scriptBytes).toBe(script.length);
    expect(e.scriptBytes).toBe(inscriptionScriptLength({ contentType: 'image/webp', body, parentId: PARENT_ID }));
    expect(e.body).toMatchObject({ chunks: 3, fullChunks: 2, lastChunkBytes: 1, bytesWithPushPrefixes: 2 * 523 + 2 });
    // direct: pubkey, "ord", 2 tags, content type, parent, last 1-byte chunk; PUSHDATA2: two 520-byte chunks
    expect(e.pushes).toEqual({ direct: 7, OP_0: 2, PUSHDATA2: 2 }); // OP_0 = OP_FALSE + body tag
    expect(e.overheadBytes).toBe(script.length - 1_041);
    expect(e.pubkeyPlaceholder).toBe(false);
    expect(e.head).toBe(hex.encode(script.subarray(0, 64)));
    const ops = e.layout.map((l: { op: string }) => l.op);
    expect(ops).toEqual(['PUSH32', 'OP_CHECKSIG', 'OP_0', 'OP_IF', 'PUSH3', 'PUSH1', 'PUSH10', 'PUSH1', 'PUSH32', 'OP_0', '3 push(es)', 'OP_ENDIF']);
  });

  it('human output is a readable layout with a placeholder key by default', async () => {
    const r = await cli(['envelope', `${FIXTURES}hello.txt`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/hello\.txt: 87-byte tapscript \(17 body bytes in 1 chunk\(s\)/);
    expect(r.stdout).toMatch(/reveal pubkey \(placeholder\)/);
    expect(r.stdout).toMatch(/"text\/plain;charset=utf-8"/);
    expect(r.stdout).toMatch(/body: 17 B/);
  });

  it('shows metadata once and handles an empty body', async () => {
    const r = await cli(['envelope', 'e.txt', '--metadata', 'm.cbor', '--json'], { files: { 'e.txt': new Uint8Array(0), 'm.cbor': bytes(600) } });
    expect(r.code).toBe(0);
    const e = r.json();
    expect(e.body.chunks).toBe(0);
    expect(e.metadataBytes).toBe(600);
    expect(e.layout.filter((l: { note: string }) => l.note.startsWith('tag 5'))).toHaveLength(1);
  });

  it('walkScript round-trips every push', () => {
    const script = buildInscriptionScript(PUB, { contentType: 'text/plain', body: bytes(5_000) });
    const ops = walkScript(script);
    expect(ops.reduce((s, o) => s + o.size, 0)).toBe(script.length);
  });
});

describe('scribbit commit-address', () => {
  it('matches commitAddress() for every network', async () => {
    const body = new TextEncoder().encode('hello, scribb.it\n');
    for (const network of ['mainnet', 'testnet', 'signet', 'regtest'] as const) {
      const r = await cli(['commit-address', `${FIXTURES}hello.txt`, '--pubkey', PUB_HEX, '--network', network, '--parent', PARENT_ID, '--json']);
      expect(r.code).toBe(0);
      const c = commitAddress(PUB, { contentType: 'text/plain;charset=utf-8', body, parentId: PARENT_ID }, network);
      expect(r.json()).toMatchObject({
        address: c.address,
        scriptPubKey: hex.encode(c.script),
        tapLeafHash: hex.encode(c.tapLeafHash),
        controlBlock: hex.encode(c.controlBlock),
        leafScriptBytes: c.leafScript.length,
        network,
      });
    }
  });

  it('accepts a compressed key (uses its x coordinate)', async () => {
    const a = await cli(['commit-address', `${FIXTURES}hello.txt`, '--pubkey', `02${PUB_HEX}`, '--network', 'mainnet', '--json']);
    const b = await cli(['commit-address', `${FIXTURES}hello.txt`, '--pubkey', PUB_HEX, '--network', 'mainnet', '--json']);
    expect(a.json().address).toBe(b.json().address);
    expect(a.json().address).toMatch(/^bc1p/);
  });

  it.each([
    [['commit-address', 'a.txt', '--network', 'mainnet'], /--pubkey <xonly> is required/],
    [['commit-address', 'a.txt', '--pubkey', PUB_HEX], /--network is required/],
    [['commit-address', 'a.txt', '--pubkey', 'abcd', '--network', 'mainnet'], /invalid --pubkey/],
  ])('usage error: %j', async (argv, msg) => {
    const r = await cli(argv as string[], { files: { 'a.txt': 'x' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(msg);
  });
});

describe('scribbit rescue', () => {
  const content = { contentType: 'text/plain', body: bytes(300), parentId: PARENT_ID };
  const recipient = commitAddress(PUB, { contentType: 'x', body: new Uint8Array(1) }, 'regtest').address;
  const half = buildHalfSignedReveal({
    network: 'regtest',
    revealPrivkey: PRIV,
    content,
    commitOutpoint: { txid: '11'.repeat(32), vout: 1 },
    commitValue: 10_000n,
    recipientAddress: recipient,
    postage: 546n,
    sighash: 'single_anyonecanpay', // the CLI `rescue` command replays legacy 0x83 PSBTs
  });
  const expected = buildRescueReveal({ network: 'regtest', halfSignedPsbtBase64: half.psbtBase64 });

  it.each([
    ['base64', ['--psbt', half.psbtBase64], {}],
    ['@file', ['--psbt', '@r.psbt'], { files: { 'r.psbt': `${half.psbtBase64}\n` } }],
    ['stdin', ['--psbt', '-'], { stdin: `  ${half.psbtBase64}\n` }],
  ])('builds the rescue tx from %s', async (_how, flags, harness) => {
    const r = await cli(['rescue', ...(flags as string[]), '--network', 'regtest', '--json'], harness);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      ok: true,
      command: 'rescue',
      txid: expected.txid,
      hex: expected.hex,
      weight: expected.weight,
      vsize: expected.vsize,
      inscriptionId: `${expected.txid}i0`,
    });
  });

  it('human output ends with the raw hex', async () => {
    const r = await cli(['rescue', '--psbt', half.psbtBase64]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').pop()).toBe(expected.hex);
  });

  it('exit 3 for an unsigned or garbage PSBT, exit 2 without --psbt', async () => {
    const bad = await cli(['rescue', '--psbt', 'cHNidP8BAA==', '--json']);
    expect(bad.code).toBe(3);
    expect(bad.json().error.code).toBe('invalid_psbt');
    const none = await cli(['rescue']);
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/--psbt <b64> is required/);
    const missing = await cli(['rescue', '--psbt', '@/no/such.psbt']);
    expect(missing.code).toBe(3);
  });
});

describe('dispatcher', () => {
  it('help and version', async () => {
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.stdout).toMatch(/Usage: scribbit <command>/);
    expect((await cli(['--help'])).code).toBe(0);
    expect((await cli(['--version'])).stdout.trim()).toBe('0.1.0');
    expect((await cli(['--version', '--json'])).json()).toEqual({ ok: true, version: '0.1.0' });
    for (const c of ['quote', 'envelope', 'commit-address', 'rescue']) {
      const a = await cli(['help', c]);
      const b = await cli([c, '--help']);
      expect(a.code).toBe(0);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stdout).toMatch(new RegExp(`^scribbit ${c}: `));
    }
  });

  it('unknown commands and options are usage errors, JSON when asked', async () => {
    const u = await cli(['inscribe']);
    expect(u.code).toBe(2);
    expect(u.stderr).toMatch(/unknown command "inscribe"/);
    const j = await cli(['inscribe', '--json']);
    expect(j.json()).toEqual({ ok: false, command: 'inscribe', exitCode: 2, error: { code: 'usage', message: 'unknown command "inscribe"; see scribbit --help' } });
    const dup = await cli(['quote', 'a.txt', '--fee-rate', '1', '--fee-rate', '2'], { files: { 'a.txt': 'x' } });
    expect(dup.code).toBe(2);
    expect(dup.stderr).toMatch(/more than once/);
    const flag = await cli(['quote', 'a.txt', '--json=yes'], { files: { 'a.txt': 'x' } });
    expect(flag.code).toBe(2);
  });

  it('--flag=value and -- terminator', async () => {
    const r = await cli(['quote', '--fee-rate=2', '--content-type=text/plain', '--json', '--', '--weird-name'], { files: { '--weird-name': 'x' } });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ file: '--weird-name', feeRate: 2, contentType: 'text/plain' });
  });
});
