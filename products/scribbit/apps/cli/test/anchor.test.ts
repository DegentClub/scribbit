import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { p2tr } from '@scure/btc-signer';
import { buildHalfSignedReveal, commitAddress, finalizeReveal } from '@bsh/inscription';
import { canonicalStringify, checkpointHead, claimsOf, generateKeyPair, inclusionProof, sealEntry, signCheckpointHead, verifyInclusionProof } from '@bsh/mesh';
import { describe, expect, it } from 'vitest';
import { ANCHOR_CONTENT_TYPE, anchorContent } from '../src/commands/anchor.js';
import { cli } from './helpers.js';

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const REVEAL_PRIV = hex.decode('01'.repeat(32));
const REVEAL_PUB = schnorr.getPublicKey(REVEAL_PRIV);
const RECIPIENT = p2tr(schnorr.getPublicKey(hex.decode('03'.repeat(32))), undefined, REGTEST).address!;

// Three sealed shipped/1 entries and an (unsealed) directory fragment, and the head over them - as `mesh emit` writes them.
const entry = (n: number) => sealEntry({ id: `ship/example/${String(n).repeat(12)}`, repo: 'repo/example', at: `2026-09-2${n}T10:00:00Z`, kind: 'feature', title: `entry ${n}`, by: ['person/alice'], asserted: '2026-09-24', assertedBy: 'agent/example-records', visibility: 'public' });
const shiplog = { shipped: '1', source: 'repo/example', org: 'org/example', generated: '2026-09-23T10:00:00.000Z', entries: [entry(3), entry(2), entry(1)] };
const directory = { directory: '0.1', source: 'repo/example', generated: '2026-09-24', nodes: [{ id: 'org/example', kind: 'Organization', name: 'Example' }], edges: [] };
const head = checkpointHead(claimsOf([shiplog, directory]), 'https://example.org', '2026-09-23T10:00:00.000Z');
const CLAIM = `ship/example/${'2'.repeat(12)}`;
const files = { 'checkpoint.json': JSON.stringify(head, null, 2), 'shiplog.json': JSON.stringify(shiplog), 'directory.fragment.json': JSON.stringify(directory) };

describe('scribbit anchor: the body', () => {
  it('is the canonical JSON of { anchor, origin, size, root, at } - deterministic, sorted, without counts or x-signature', async () => {
    const a = await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '2', '--json'], { files });
    expect(a.code).toBe(0);
    const j = a.json();
    expect(j).toMatchObject({ ok: true, command: 'anchor', contentType: ANCHOR_CONTENT_TYPE, head: { origin: 'https://example.org', size: 3, root: head.root, at: head.at } });
    expect(j.bodyText).toBe(`{"anchor":"1","at":"${head.at}","origin":"https://example.org","root":"${head.root}","size":3}`);
    expect(j.bodyText).toBe(canonicalStringify(j.body));
    expect(j.bodyBytes).toBe(new TextEncoder().encode(j.bodyText).length);
    expect(j.body).toEqual({ anchor: '1', origin: 'https://example.org', size: 3, root: head.root, at: head.at });
    expect(j.bodyText).not.toContain('counts');
    // The same head, re-serialised with keys shuffled and a signature added, anchors the same bytes.
    const { privateKey } = generateKeyPair();
    const signed = signCheckpointHead(head, privateKey);
    const shuffled = JSON.stringify({ 'x-signature': signed['x-signature'], at: head.at, root: head.root, counts: head.counts, size: head.size, origin: head.origin, checkpoint: '1' });
    const b = await cli(['anchor', 'cp2.json', '--network', 'regtest', '--fee-rate', '2', '--json'], { files: { 'cp2.json': shuffled } });
    expect(b.json().bodyText).toBe(j.bodyText);
    expect(b.json().signature).toMatchObject({ ok: true, kid: signed['x-signature'].kid });
    expect(b.json().reveal).toEqual(j.reveal);
    expect(anchorContent(head).text).toBe(j.bodyText);
  });

  it('rejects a file that is not a checkpoint/1 head (exit 3) and needs --network (exit 2)', async () => {
    expect((await cli(['anchor', 'checkpoint.json', '--fee-rate', '2'], { files })).code).toBe(2);
    for (const bad of [JSON.stringify({ ...head, checkpoint: '2' }), JSON.stringify({ ...head, root: 'nope' }), JSON.stringify({ ...head, size: -1 }), '{not json']) {
      const r = await cli(['anchor', 'bad.json', '--network', 'regtest', '--fee-rate', '2', '--json'], { files: { 'bad.json': bad } });
      expect(r.code).toBe(3);
      expect(r.json()).toMatchObject({ ok: false, error: { code: 'bad_checkpoint' } });
    }
  });
});

describe('scribbit anchor: the quote equals a real signed reveal', () => {
  it('weight, vsize, fee and commit address match buildHalfSignedReveal + finalizeReveal for the same body', async () => {
    const r = await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '3.3', '--pubkey', hex.encode(REVEAL_PUB), '--recipient', RECIPIENT, '--json'], { files });
    expect(r.code).toBe(0);
    const q = r.json();
    expect(q.recipient).toBe('p2tr');
    expect(q.reveal).toMatchObject({ layout: 'single', lane: 'standard' });
    const { content } = anchorContent(head);
    const half = buildHalfSignedReveal({
      network: 'regtest',
      revealPrivkey: REVEAL_PRIV,
      content,
      commitOutpoint: { txid: 'ab'.repeat(32), vout: 0 },
      commitValue: BigInt(q.fees.commitValue),
      recipientAddress: RECIPIENT,
      postage: 546n,
    });
    const final = finalizeReveal(half.psbtBase64);
    expect(final.weight).toBe(q.reveal.weight);
    expect(final.vsize).toBe(q.reveal.vsize);
    expect(q.fees.commitValue - 546).toBe(q.fees.revealFee);
    expect(q.fees.revealFee).toBe(Math.ceil(final.vsize * 3.3));
    const commit = commitAddress(REVEAL_PUB, content, 'regtest');
    expect(q.commit).toMatchObject({ address: commit.address, scriptPubKey: hex.encode(commit.script), tapLeafHash: hex.encode(commit.tapLeafHash), leafScriptBytes: commit.leafScript.length });
    expect(q.envelope.scriptBytes).toBe(commit.leafScript.length);
    // Human output carries the inclusion section and the same numbers.
    const h = await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '3.3'], { files });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('inclusion');
    expect(h.stdout).toContain('anchor-verify');
    expect(h.stdout).toContain(`${q.reveal.weight.toLocaleString('en-US')} WU`);
    expect(h.stdout).toContain('pass --pubkey');
  });

  it('with --claims it recomputes the root from the fragments, and with --claim it prints a proof', async () => {
    const r = await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '1', '--claims', 'shiplog.json', 'directory.fragment.json', '--claim', CLAIM, '--json'], { files });
    expect(r.code).toBe(0);
    const inc = r.json().inclusion;
    expect(inc).toMatchObject({ fragments: ['shiplog.json', 'directory.fragment.json'], claims: 3, rootMatches: true, recomputedRoot: head.root, claim: CLAIM, verified: true });
    expect(inc.proof).toEqual(inclusionProof(claimsOf([shiplog, directory]), CLAIM, 'https://example.org'));
    expect(inc.how.length).toBeGreaterThan(3);
    expect(r.json().warnings).toEqual([]);
    const missing = await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '1', '--claims', 'shiplog.json', '--claim', 'ship/example/nope', '--json'], { files });
    expect(missing.json().inclusion).toMatchObject({ verified: false, proof: null });
    expect(missing.json().warnings.join(' ')).toContain('not in the fragments');
    expect((await cli(['anchor', 'checkpoint.json', '--network', 'regtest', '--fee-rate', '1', '--claim', CLAIM, '--json'], { files })).code).toBe(2);
  });
});

describe('scribbit anchor-verify', () => {
  it('accepts a valid proof and prints it', async () => {
    const r = await cli(['anchor-verify', 'checkpoint.json', '--claim', CLAIM, '--claims', 'shiplog.json', 'directory.fragment.json', '--json'], { files });
    expect(r.code).toBe(0);
    const j = r.json();
    const proof = inclusionProof(claimsOf([shiplog, directory]), CLAIM, 'https://example.org')!;
    expect(j).toMatchObject({ ok: true, command: 'anchor-verify', claim: CLAIM, claims: 3, verified: true, proof, signature: null });
    expect(verifyInclusionProof(j.proof, head.root)).toBe(true);
    const h = await cli(['anchor-verify', 'checkpoint.json', '--claim', CLAIM, '--claims', 'shiplog.json'], { files });
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(new RegExp(`leaf\\s+${proof.index} of ${proof.size}`));
    expect(h.stdout).toContain('verified');
  });

  it('refuses a tampered root, a tampered fragment and an unknown claim (exit 3)', async () => {
    const tamperedHead = { ...head, root: 'f'.repeat(64) };
    const a = await cli(['anchor-verify', 'checkpoint.json', '--claim', CLAIM, '--claims', 'shiplog.json', '--json'], { files: { ...files, 'checkpoint.json': JSON.stringify(tamperedHead) } });
    expect(a.code).toBe(3);
    expect(a.json()).toMatchObject({ ok: false, exitCode: 3, error: { code: 'inclusion_failed' } });
    expect(a.json().error.message).toContain(head.root); // what the fragments hash to
    expect(a.json().error.message).toContain('f'.repeat(64)); // what the head anchors

    const tamperedLog = { ...shiplog, entries: [{ ...shiplog.entries[0]!, digest: '0'.repeat(64) }, ...shiplog.entries.slice(1)] };
    const b = await cli(['anchor-verify', 'checkpoint.json', '--claim', CLAIM, '--claims', 'shiplog.json', '--json'], { files: { ...files, 'shiplog.json': JSON.stringify(tamperedLog) } });
    expect(b.code).toBe(3);
    expect(b.json().error.code).toBe('inclusion_failed');

    const c = await cli(['anchor-verify', 'checkpoint.json', '--claim', 'ship/example/nope', '--claims', 'shiplog.json', '--json'], { files });
    expect(c.code).toBe(3);
    expect(c.json().error.code).toBe('claim_not_found');
    expect((await cli(['anchor-verify', 'checkpoint.json', '--claims', 'shiplog.json'], { files })).code).toBe(2);
    expect((await cli(['anchor-verify', 'checkpoint.json', '--claim', CLAIM], { files })).code).toBe(2);
  });
});

describe('--json prints exactly one object', () => {
  it.each([
    ['anchor', ['anchor', 'checkpoint.json', '--network', 'signet', '--fee-rate', '1', '--claims', 'shiplog.json', '--claim', CLAIM, '--json']],
    ['anchor-verify', ['anchor-verify', 'checkpoint.json', '--claim', CLAIM, '--claims', 'shiplog.json', '--json']],
    ['anchor-verify (refused)', ['anchor-verify', 'checkpoint.json', '--claim', 'ship/example/nope', '--claims', 'shiplog.json', '--json']],
  ])('%s', async (_name, argv) => {
    const r = await cli(argv, { files });
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(typeof JSON.parse(r.stdout)).toBe('object');
  });
});
