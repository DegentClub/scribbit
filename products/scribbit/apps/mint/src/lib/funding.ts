/**
 * Funding (commit) PSBT construction for the ordinals page. The wallet's payment UTXOs pay
 *   [0] the commit address (commit value = reveal fee + postage)
 *   [1] change back to the payment address, when above dust.
 *
 * The txid is computed from the UNSIGNED transaction: possible because every input is segwit (witnesses are
 * not part of the txid); nested segwit contributes a deterministic scriptSig which is included. After the
 * wallet signs, the txid is re-checked: a wallet that changed anything would orphan the reveal.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Network } from '@bsh/inscription';
import type { AddressType, Utxo, WalletAccount } from '../services/types';
import { UserFacingError } from './errors';

export const DUST_CHANGE = 546;
/** When payment and ordinals share an address (UniSat, OKX, XCP), small coins may carry inscriptions. */
export const INSCRIPTION_GUARD_SATS = 10_000;

export class InsufficientFundsError extends UserFacingError {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(
      `Not enough spendable funds: need about ${needed.toLocaleString('en-US')} sats (including the funding fee), have ${available.toLocaleString('en-US')} sats available.`,
      'Send more bitcoin to the payment address or lower the fee rate, then refresh the quote.',
    );
    this.name = 'InsufficientFundsError';
  }
}

export function scureNetwork(network: Network): typeof btc.NETWORK {
  if (network === 'mainnet') return btc.NETWORK;
  if (network === 'regtest') return { ...btc.TEST_NETWORK, bech32: 'bcrt' };
  return btc.TEST_NETWORK;
}

export function classifyAddress(address: string): AddressType {
  const a = address.toLowerCase();
  if (/^(bc|tb|bcrt)1p/.test(a)) return 'p2tr';
  if (/^(bc|tb|bcrt)1q/.test(a)) return a.replace(/^(bc|tb|bcrt)1/, '').length <= 42 ? 'p2wpkh' : 'unknown';
  if (/^[23]/.test(address)) return 'p2sh-p2wpkh';
  if (/^[1mn]/.test(address)) return 'p2pkh';
  return 'unknown';
}

const INPUT_VBYTES: Record<'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh', number> = { p2tr: 57.5, p2wpkh: 68, 'p2sh-p2wpkh': 91 };

export function outputVbytes(address: string): number {
  switch (classifyAddress(address)) {
    case 'p2tr':
      return 43;
    case 'p2wpkh':
      return 31;
    case 'p2sh-p2wpkh':
      return 32;
    case 'p2pkh':
      return 34;
    default:
      return 43;
  }
}

export function spendableType(account: WalletAccount): 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' {
  const t = account.addressType === 'unknown' ? classifyAddress(account.address) : account.addressType;
  if (t === 'p2tr' || t === 'p2wpkh' || t === 'p2sh-p2wpkh') return t;
  throw new UserFacingError(
    `The payment address ${account.address} is a legacy address, and its transaction id changes when it is signed, so the reveal could not be prepared against it.`,
    'Switch the wallet to a Native SegWit (bc1q…), Nested SegWit (3…) or Taproot (bc1p…) account and reconnect.',
  );
}

export interface CoinSelection {
  inputs: Utxo[];
  outputs: Array<{ address: string; value: number; label: 'commit' | 'change' }>;
  fee: number;
  vsize: number;
  excluded: Utxo[];
}

/** Largest-first, confirmed first; tiny coins skipped when the payment address may hold inscriptions. */
export function selectCoins(args: { utxos: Utxo[]; inputType: 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh'; commitAddress: string; commitValue: number; changeAddress: string; feeRate: number; guardInscriptions: boolean }): CoinSelection {
  const excluded = args.guardInscriptions ? args.utxos.filter((u) => u.value <= INSCRIPTION_GUARD_SATS) : [];
  const pool = args.utxos.filter((u) => !excluded.includes(u)).sort((a, b) => Number(b.status.confirmed) - Number(a.status.confirmed) || b.value - a.value);
  const baseVb = 10.5 + outputVbytes(args.commitAddress);
  const perInput = INPUT_VBYTES[args.inputType];
  const changeVb = outputVbytes(args.changeAddress);
  const chosen: Utxo[] = [];
  let total = 0;
  for (const u of pool) {
    chosen.push(u);
    total += u.value;
    const vbNoChange = baseVb + perInput * chosen.length;
    const feeNoChange = Math.ceil(vbNoChange * args.feeRate);
    if (total < args.commitValue + feeNoChange) continue;
    const vbChange = vbNoChange + changeVb;
    const feeChange = Math.ceil(vbChange * args.feeRate);
    const change = total - args.commitValue - feeChange;
    const outputs: CoinSelection['outputs'] = [{ address: args.commitAddress, value: args.commitValue, label: 'commit' }];
    if (change >= DUST_CHANGE) {
      outputs.push({ address: args.changeAddress, value: change, label: 'change' });
      return { inputs: chosen, outputs, fee: feeChange, vsize: Math.ceil(vbChange), excluded };
    }
    return { inputs: chosen, outputs, fee: total - args.commitValue, vsize: Math.ceil(vbNoChange), excluded };
  }
  const needed = args.commitValue + Math.ceil((baseVb + perInput * Math.max(1, pool.length)) * args.feeRate);
  throw new InsufficientFundsError(needed, total);
}

export interface FundingPsbt {
  psbtBase64: string;
  txid: string;
  commitVout: number;
  selection: CoinSelection;
  inputsToSign: Array<{ index: number; address: string }>;
}

function xOnly(pubHex: string): Uint8Array {
  const b = hex.decode(pubHex);
  if (b.length === 32) return b;
  if (b.length === 33) return b.slice(1);
  throw new Error('Taproot payment account is missing a valid public key.');
}

const dsha256 = (b: Uint8Array) => sha256(sha256(b));

/** txid of the unsigned transaction, including deterministic nested-segwit scriptSigs. */
export function unsignedTxid(tx: btc.Transaction, scriptSigs: Array<Uint8Array | undefined>): string {
  const inputs = Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    return { txid: inp.txid!, index: inp.index!, sequence: inp.sequence ?? btc.DEFAULT_SEQUENCE, finalScriptSig: scriptSigs[i] ?? new Uint8Array() };
  });
  const outputs = Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i);
    return { amount: o.amount!, script: o.script! };
  });
  const raw = btc.RawTx.encode({ version: tx.version, lockTime: tx.lockTime, inputs, outputs, witnesses: [], segwitFlag: false });
  return hex.encode(dsha256(raw).reverse());
}

export function buildFundingPsbt(args: { network: Network; utxos: Utxo[]; payment: WalletAccount; ordinalsAddress: string; commitAddress: string; commitValue: number; feeRate: number }): FundingPsbt {
  const net = scureNetwork(args.network);
  const inputType = spendableType(args.payment);
  const selection = selectCoins({
    utxos: args.utxos,
    inputType,
    commitAddress: args.commitAddress,
    commitValue: args.commitValue,
    changeAddress: args.payment.address,
    feeRate: args.feeRate,
    guardInscriptions: args.payment.address === args.ordinalsAddress,
  });
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const payScript = btc.OutScript.encode(btc.Address(net).decode(args.payment.address));
  const scriptSigs: Array<Uint8Array | undefined> = [];
  for (const u of selection.inputs) {
    const base = { txid: u.txid, index: u.vout, witnessUtxo: { script: payScript, amount: BigInt(u.value) } };
    if (inputType === 'p2tr') {
      tx.addInput({ ...base, tapInternalKey: xOnly(args.payment.publicKey) });
      scriptSigs.push(undefined);
    } else if (inputType === 'p2sh-p2wpkh') {
      const redeemScript = btc.p2wpkh(hex.decode(args.payment.publicKey), net).script;
      tx.addInput({ ...base, redeemScript });
      scriptSigs.push(btc.Script.encode([redeemScript]));
    } else {
      tx.addInput(base);
      scriptSigs.push(undefined);
    }
  }
  for (const o of selection.outputs) tx.addOutputAddress(o.address, BigInt(o.value), net);
  return {
    psbtBase64: base64.encode(tx.toPSBT()),
    txid: unsignedTxid(tx, scriptSigs),
    commitVout: 0,
    selection,
    inputsToSign: selection.inputs.map((_, index) => ({ index, address: args.payment.address })),
  };
}

/** Finalize (if needed) a wallet-signed PSBT and return the raw tx + txid. */
export function extractSignedTx(psbtBase64: string): { hex: string; txid: string } {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), { allowUnknownInputs: true, allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
  if (!tx.isFinal) tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id };
}

export class TxidMismatchError extends UserFacingError {
  constructor(expected: string, got: string) {
    super(
      `Your wallet changed the transaction (expected txid ${expected}, got ${got}). It was NOT broadcast.`,
      'The reveal was prepared against the original transaction, so broadcasting this one would strand the funds. Rebuild the quote and sign again; if the wallet keeps altering it, try another wallet.',
    );
    this.name = 'TxidMismatchError';
  }
}

/** The txid check: refuses a signed commit whose id differs from the one the reveal was built for. */
export function assertTxidUnchanged(signedPsbtBase64: string, expectedTxid: string): { hex: string; txid: string } {
  const out = extractSignedTx(signedPsbtBase64);
  if (out.txid !== expectedTxid) throw new TxidMismatchError(expectedTxid, out.txid);
  return out;
}
