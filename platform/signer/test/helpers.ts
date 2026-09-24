import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { base64, hex } from '@scure/base';
import { p2tr, TEST_NETWORK, Transaction } from '@scure/btc-signer';

export const PRIV_A = hex.decode('1111111111111111111111111111111111111111111111111111111111111111');
export const PRIV_B = hex.decode('2222222222222222222222222222222222222222222222222222222222222222');
export const XONLY_A = schnorr.getPublicKey(PRIV_A);
export const XONLY_B = schnorr.getPublicKey(PRIV_B);
export const P2TR_A = p2tr(XONLY_A, undefined, TEST_NETWORK);
export const P2TR_B = p2tr(XONLY_B, undefined, TEST_NETWORK);

export const PREV_TXID = 'ab'.repeat(32);
export const RECIPIENT = P2TR_B.address!;

export interface PsbtOpts {
  /** Which key's P2TR the (single) input pays. */
  payTo?: typeof P2TR_A;
  amount?: bigint;
  outputs?: Array<{ address: string; amount: bigint }>;
  sighashType?: number;
  tapInternalKey?: Uint8Array | null;
  tapMerkleRoot?: Uint8Array;
  extraInputs?: number;
  /** Let btc-signer build an inconsistent input (for negative tests). */
  disableScriptCheck?: boolean;
}

/** A real PSBT with a key-path P2TR input (plus optional extra P2TR-B inputs) spending to `outputs`. */
export function keyPathPsbt(o: PsbtOpts = {}): { psbtBase64: string; tx: Transaction } {
  const pay = o.payTo ?? P2TR_A;
  const amount = o.amount ?? 50_000n;
  const tx = new Transaction({ allowUnknownOutputs: true, ...(o.disableScriptCheck ? { disableScriptCheck: true } : {}) });
  tx.addInput({
    txid: PREV_TXID,
    index: 0,
    witnessUtxo: { script: pay.script, amount },
    ...(o.tapInternalKey === null ? {} : { tapInternalKey: o.tapInternalKey ?? (pay === P2TR_B ? XONLY_B : XONLY_A) }),
    ...(o.sighashType !== undefined ? { sighashType: o.sighashType } : {}),
    ...(o.tapMerkleRoot ? { tapMerkleRoot: o.tapMerkleRoot } : {}),
  });
  for (let i = 0; i < (o.extraInputs ?? 0); i++) {
    tx.addInput({ txid: 'cd'.repeat(32), index: i + 1, witnessUtxo: { script: P2TR_B.script, amount: 10_000n }, tapInternalKey: XONLY_B });
  }
  for (const out of o.outputs ?? [{ address: RECIPIENT, amount: amount - 1_000n }]) tx.addOutputAddress(out.address, out.amount, TEST_NETWORK);
  return { psbtBase64: base64.encode(tx.toPSBT()), tx };
}

export const fromPsbt = (b64: string) => Transaction.fromPSBT(base64.decode(b64), { allowUnknownInputs: true, allowUnknownOutputs: true });

// ---------------------------------------------------------------------------------------------------
// Independent BIP341 sighash (key path, no annex, no script). Written from the BIP text so the test does
// not trust btc-signer's `preimageWitnessV1` (the signer's own implementation) for correctness.

const le32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const le64 = (n: bigint) => {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const varint = (n: number) => {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >>> 8]);
  return concatBytes(new Uint8Array([0xfe]), le32(n));
};
const withLen = (b: Uint8Array) => concatBytes(varint(b.length), b);
const reverse = (b: Uint8Array) => Uint8Array.from(b).reverse();

export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...msgs));
}

export interface SimplePrevout {
  txid: string; // display order (as in JSON)
  vout: number;
  amount: bigint;
  script: Uint8Array;
  sequence: number;
}

export function bip341KeyPathSighash(
  tx: { version: number; lockTime: number; outputs: Array<{ amount: bigint; script: Uint8Array }> },
  prevouts: SimplePrevout[],
  inputIndex: number,
  hashType: number,
): Uint8Array {
  const anyoneCanPay = (hashType & 0x80) !== 0;
  const outType = hashType & 3;
  const parts: Uint8Array[] = [new Uint8Array([hashType]), le32(tx.version), le32(tx.lockTime)];
  if (!anyoneCanPay) {
    parts.push(sha256(concatBytes(...prevouts.map((p) => concatBytes(reverse(hex.decode(p.txid)), le32(p.vout))))));
    parts.push(sha256(concatBytes(...prevouts.map((p) => le64(p.amount)))));
    parts.push(sha256(concatBytes(...prevouts.map((p) => withLen(p.script)))));
    parts.push(sha256(concatBytes(...prevouts.map((p) => le32(p.sequence)))));
  }
  if (outType !== 2 && outType !== 3) parts.push(sha256(concatBytes(...tx.outputs.map((o) => concatBytes(le64(o.amount), withLen(o.script))))));
  parts.push(new Uint8Array([0])); // spend_type: no extension, no annex
  if (anyoneCanPay) {
    const p = prevouts[inputIndex]!;
    parts.push(reverse(hex.decode(p.txid)), le32(p.vout), le64(p.amount), withLen(p.script), le32(p.sequence));
  } else {
    parts.push(le32(inputIndex));
  }
  if (outType === 3) {
    const o = tx.outputs[inputIndex]!;
    parts.push(sha256(concatBytes(le64(o.amount), withLen(o.script))));
  }
  return taggedHash('TapSighash', new Uint8Array([0]), ...parts);
}

export function prevoutsOf(tx: Transaction): SimplePrevout[] {
  const out: SimplePrevout[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    out.push({ txid: hex.encode(inp.txid!), vout: inp.index!, amount: inp.witnessUtxo!.amount, script: inp.witnessUtxo!.script, sequence: inp.sequence ?? 0xffffffff });
  }
  return out;
}

export function outputsOf(tx: Transaction): Array<{ amount: bigint; script: Uint8Array }> {
  const out: Array<{ amount: bigint; script: Uint8Array }> = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    out.push({ amount: o.amount!, script: o.script! });
  }
  return out;
}
