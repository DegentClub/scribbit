import { describe, expect, it } from 'vitest';
import { canonicalStringify, sha256Hex } from '@bsh/mesh';
import { auditHash, chainEntry, GENESIS, signAuditHead, verifyAuditChain, verifyAuditHead, type AuditEntry, type AuditFact } from '../src/audit.ts';
import { MemoryPlaneStore } from '../src/store/memory.ts';
import { SqlitePlaneStore } from '../src/store/sqlite.ts';
import { PLANE_KEY, RETIRED_KEY, STRANGER_KEY, T0 } from './helpers.ts';

const fact = (i: number, over: Partial<AuditFact> = {}): AuditFact => ({ at: new Date(T0 + i * 1000).toISOString(), kind: 'decision', id: `dec_${i}`, data: { verdict: 'DENY', code: 'NO_ENVELOPE', n: i }, ...over });

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (let i = 0; i < n; i++) out.push(chainEntry(out.at(-1), fact(i)));
  return out;
}

describe('audit entries (FlashyOS ProvenanceEntry shape)', () => {
  it('hash = sha256(canonical({seq, at, kind, id, data, prev})), prev 64 zeros first', () => {
    const [e0, e1] = chain(2) as [AuditEntry, AuditEntry];
    expect(e0).toMatchObject({ seq: 0, prev: GENESIS });
    expect(e0.hash).toBe(sha256Hex(canonicalStringify({ seq: 0, at: e0.at, kind: 'decision', id: 'dec_0', data: e0.data, prev: GENESIS })));
    expect(e1).toMatchObject({ seq: 1, prev: e0.hash });
    expect(auditHash(e1)).toBe(e1.hash);
  });
  it('a clean chain verifies, and so does any page given the prev of its first entry', () => {
    const log = chain(10);
    expect(verifyAuditChain(log)).toEqual({ ok: true, entries: 10, head: { seq: 9, hash: log[9]!.hash } });
    expect(verifyAuditChain(log.slice(4), { prev: log[3]!.hash, startSeq: 4 })).toMatchObject({ ok: true, entries: 6 });
    expect(verifyAuditChain([])).toEqual({ ok: true, entries: 0, head: null });
  });
});

describe('tamper detection names the entry', () => {
  const log = chain(6);
  const edit = (i: number, f: (e: AuditEntry) => AuditEntry) => log.map((e, j) => (j === i ? f(structuredClone(e)) : e));
  it('an edited verdict is HASH_MISMATCH', () => {
    expect(verifyAuditChain(edit(3, (e) => ({ ...e, data: { ...e.data, verdict: 'ALLOW' } })))).toMatchObject({ ok: false, code: 'HASH_MISMATCH', seq: 3 });
  });
  it('a recomputed hash after an edit breaks the next link: CHAIN_BROKEN', () => {
    const forged = edit(3, (e) => {
      const x = { ...e, data: { ...e.data, verdict: 'ALLOW' } };
      return { ...x, hash: auditHash(x) };
    });
    expect(verifyAuditChain(forged)).toMatchObject({ ok: false, code: 'CHAIN_BROKEN', seq: 4 });
  });
  it('a dropped entry is SEQ_GAP; a reordered pair is SEQ_GAP; a backdated one NOT_ORDERED', () => {
    expect(verifyAuditChain([...log.slice(0, 2), ...log.slice(3)])).toMatchObject({ code: 'SEQ_GAP', seq: 2 });
    expect(verifyAuditChain([log[0], log[2], log[1]])).toMatchObject({ code: 'SEQ_GAP', seq: 1 });
    const back: AuditEntry[] = [];
    for (const [i, t] of [[0, 5000], [1, 1000]] as const) back.push(chainEntry(back.at(-1), fact(i, { at: new Date(T0 + t).toISOString() })));
    expect(verifyAuditChain(back)).toMatchObject({ code: 'NOT_ORDERED', seq: 1 });
  });
  it('a page verified against the wrong prev is CHAIN_BROKEN; junk is MALFORMED', () => {
    expect(verifyAuditChain(log.slice(2), { prev: GENESIS, startSeq: 2 })).toMatchObject({ code: 'CHAIN_BROKEN', seq: 2 });
    expect(verifyAuditChain([{ seq: 0 }])).toMatchObject({ code: 'MALFORMED' });
  });
});

describe('the signed head', () => {
  const log = chain(3);
  const head = signAuditHead('scribbit', log[2]!, PLANE_KEY.privateKey);
  it('verifies under the plane key (and a retired one kept trusted), not under a stranger\'s', () => {
    expect(head).toMatchObject({ version: 1, org: 'scribbit', seq: 2, hash: log[2]!.hash });
    expect(verifyAuditHead(head, [PLANE_KEY.publicKey])).toBe(true);
    expect(verifyAuditHead(signAuditHead('scribbit', log[2]!, RETIRED_KEY.privateKey), [PLANE_KEY.publicKey, RETIRED_KEY.publicKey])).toBe(true);
    expect(verifyAuditHead(head, [STRANGER_KEY.publicKey])).toBe(false);
    expect(verifyAuditHead({ ...head, seq: 1 }, [PLANE_KEY.publicKey])).toBe(false);
    expect(verifyAuditHead({ ...head, sig: '!!' }, [PLANE_KEY.publicKey])).toBe(false);
    expect(verifyAuditHead(null, [PLANE_KEY.publicKey])).toBe(false);
  });
  it('a page must end at the head: truncation and extension are HEAD_MISMATCH; a forged head BAD_SIGNATURE', () => {
    expect(verifyAuditChain(log, { head, trustedKeys: [PLANE_KEY.publicKey] })).toMatchObject({ ok: true });
    expect(verifyAuditChain(log.slice(0, 2), { head, trustedKeys: [PLANE_KEY.publicKey] })).toMatchObject({ code: 'HEAD_MISMATCH' });
    expect(verifyAuditChain(log, { head: signAuditHead('scribbit', log[2]!, STRANGER_KEY.privateKey), trustedKeys: [PLANE_KEY.publicKey] })).toMatchObject({ code: 'BAD_SIGNATURE' });
  });
});

describe.each([
  ['memory', () => new MemoryPlaneStore()],
  ['sqlite', () => new SqlitePlaneStore(':memory:')],
] as const)('append-only log on the %s store', (_n, make) => {
  it('appends per organisation, pages by seq, and refuses an entry that does not extend the head', async () => {
    const store = make();
    for (let i = 0; i < 5; i++) await store.appendAudit('scribbit', (h) => chainEntry(h, fact(i)));
    await store.appendAudit('degent', (h) => chainEntry(h, fact(0)));
    const all = await store.listAudit('scribbit', -1, 100);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(verifyAuditChain(all)).toMatchObject({ ok: true });
    expect((await store.listAudit('scribbit', 2, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect((await store.auditHead('scribbit'))?.seq).toBe(4);
    expect((await store.listAudit('degent', -1, 10)).map((e) => e.prev)).toEqual([GENESIS]);
    await expect(store.appendAudit('scribbit', () => chainEntry(undefined, fact(9)))).rejects.toThrow(/does not extend/);
    expect((await store.auditHead('scribbit'))?.seq).toBe(4);
  });
});
