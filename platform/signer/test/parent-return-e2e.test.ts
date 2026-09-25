/**
 * End-to-end: the exact lean PSBT the degent mint sends (unsigned tx + witnessUtxo prevouts for both
 * inputs, no tapLeafScript / signature on input 1 — see remote-policy-signer.ts in DegentClub/degent and
 * RUNBOOK.md "degent parent co-signing"), signed through the real HTTP app and RemoteSignerClient, with
 * the `parentReturn` policy wired in exactly as `SIGNER_POLICY=parent-return` configures it.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { p2tr } from '@scure/btc-signer';
import { InMemoryApiKeyStore, generateApiKey } from '@bsh/edge';
import { InMemoryAuditLog, InMemoryKeyProvider, parentReturn, RemoteSignerClient, RemoteSignerError, Signer, createSignerApp, type FetchLike } from '../src/index.js';
import { P2TR_A, PRIV_A, RECIPIENT, XONLY_A, keyPathPsbt } from './helpers.js';

const PARENT_VALUE = 10_000n;
const MAX_FEE = 9_000n;

/** A lean PSBT shaped exactly like the mint's: input 0 = parent (key 'a'), input 1 = user commit (key 'b'). */
function leanReveal(outputs?: Array<{ address: string; amount: bigint }>): string {
  return keyPathPsbt({
    payTo: P2TR_A,
    amount: PARENT_VALUE,
    extraInputs: 1, // the commit input: pays P2TR_B, witnessUtxo only, fixed at 10_000n by the helper
    outputs: outputs ?? [
      { address: P2TR_A.address!, amount: PARENT_VALUE }, // parent return: same script + value as input 0
      { address: RECIPIENT, amount: 1_000n }, // child postage, P2TR_B (>= 330-sat dust)
    ],
  }).psbtBase64;
}

function setup(opts: { maxFeeSats?: bigint } = {}) {
  const store = new InMemoryApiKeyStore();
  const signerKey = generateApiKey('live');
  const adminKey = generateApiKey('live');
  store.add({ id: 'degent-mint', hash: signerKey.hash, env: 'live', scopes: ['sign:a'] });
  store.add({ id: 'admin', hash: adminKey.hash, env: 'live', scopes: ['audit:read'] });
  const auditLog = new InMemoryAuditLog();
  const signer = new Signer({
    keys: new InMemoryKeyProvider([['a', PRIV_A]]),
    audit: auditLog,
    allowedPurposes: [],
    allowedSighashTypes: [0x00],
    taprootPolicies: [parentReturn({ keyId: 'a', maxFeeSats: opts.maxFeeSats ?? MAX_FEE })],
    network: 'signet',
  });
  const app = createSignerApp({ signer, keys: store, keyEnv: 'live', auditLog });
  const fetchImpl = app.request.bind(app) as unknown as FetchLike;
  const client = new RemoteSignerClient({ baseUrl: 'http://signer.internal', apiKey: signerKey.key, fetch: fetchImpl, retries: 0 });
  const audit = async (query = ''): Promise<{ records: Array<Record<string, unknown>>; total: number }> => {
    const res = await app.request(`/v1/audit${query}`, { headers: { Authorization: `Bearer ${adminKey.key}` } });
    return (await res.json()) as { records: Array<Record<string, unknown>>; total: number };
  };
  return { client, audit };
}

describe('parent-return policy, wired end to end through the HTTP app + RemoteSignerClient', () => {
  it('signs the exact shape the mint sends, and the signature verifies against the collection output key', async () => {
    const { client, audit } = setup();
    const res = await client.signTaprootKeyPath({ psbtBase64: leanReveal(), inputIndex: 0, keyId: 'a', finalize: false });
    expect(res).toMatchObject({ keyId: 'a', inputIndex: 0, sighashType: 0 });
    const outputKey = p2tr(XONLY_A).tweakedPubkey;
    expect(schnorr.verify(hex.decode(res.signature), hex.decode(res.digest), outputKey)).toBe(true);
    expect((await audit('?decision=allow')).records[0]).toMatchObject({ decision: 'allow', keyId: 'a' });
  });

  it('refuses (403 policy_denied) when output 0 does not return the parent to its own script, and audits the code', async () => {
    const { client, audit } = setup();
    const psbtBase64 = leanReveal([{ address: RECIPIENT, amount: PARENT_VALUE }, { address: RECIPIENT, amount: 1_000n }]);
    const e = (await client.signTaprootKeyPath({ psbtBase64, inputIndex: 0, keyId: 'a' }).catch((x: unknown) => x)) as RemoteSignerError;
    expect(e).toBeInstanceOf(RemoteSignerError);
    expect(e).toMatchObject({ code: 'policy_denied', status: 403, isDenial: true });
    expect(e.message).toContain('parent_return_script_mismatch');

    const { records, total } = await audit('?decision=deny');
    expect(total).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'deny', keyId: 'a', denialCode: 'parent_return_script_mismatch' });
  });

  it('refuses a third output (too_many_outputs) and postage below dust (postage_below_dust)', async () => {
    const { client, audit } = setup();
    const extraOutput = leanReveal([{ address: P2TR_A.address!, amount: PARENT_VALUE }, { address: RECIPIENT, amount: 1_000n }, { address: RECIPIENT, amount: 1_000n }]);
    const e1 = (await client.signTaprootKeyPath({ psbtBase64: extraOutput, inputIndex: 0, keyId: 'a' }).catch((x: unknown) => x)) as RemoteSignerError;
    expect(e1.message).toContain('too_many_outputs');

    const dust = leanReveal([{ address: P2TR_A.address!, amount: PARENT_VALUE }, { address: RECIPIENT, amount: 329n }]);
    const e2 = (await client.signTaprootKeyPath({ psbtBase64: dust, inputIndex: 0, keyId: 'a' }).catch((x: unknown) => x)) as RemoteSignerError;
    expect(e2.message).toContain('postage_below_dust');

    const { records } = await audit('?decision=deny');
    expect(records.map((r) => r.denialCode)).toEqual(['postage_below_dust', 'too_many_outputs']); // newest first
  });

  it('refuses a fee above the configured cap', async () => {
    const { client } = setup({ maxFeeSats: 1_000n }); // the shape's real fee (9000) now exceeds the cap
    const e = (await client.signTaprootKeyPath({ psbtBase64: leanReveal(), inputIndex: 0, keyId: 'a' }).catch((x: unknown) => x)) as RemoteSignerError;
    expect(e).toBeInstanceOf(RemoteSignerError);
    expect(e.message).toContain('fee_above_cap');
  });
});
