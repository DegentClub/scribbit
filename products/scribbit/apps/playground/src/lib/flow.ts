/**
 * Steps 3 and 4 against the ports, so their ORDER is testable:
 *
 *   quoteFile       exact reveal weight/vsize/fee/lane from @bsh/inscription (the mint's InscriptionOps),
 *                   commit address for the wallet's leaf key, then the funding PSBT over the wallet's UTXOs
 *                   (so the total is exact too) and the unsigned reveal PSBT against the funding txid
 *   commit          wallet signs WITHOUT broadcasting → txid must be unchanged → broadcaster relays
 *   reveal          wallet signs the tapscript input → finalizeWalletSignedReveal verifies the signature →
 *                   broadcaster relays → inscription id
 *
 * Funding and reveal construction are the mint's (`@bsh/scribbit-mint` lib/funding), unchanged.
 */
import type { InscriptionContent } from '@bsh/inscription';
import { planRevealSigning } from '@bsh/scribbit-mint/src/lib/walletRouting';
import { assertTxidUnchanged, buildFundingPsbt, type CoinSelection } from '@bsh/scribbit-mint/src/lib/funding';
import { UserFacingError } from '@bsh/scribbit-mint/src/lib/errors';
import type { RevealQuote } from '@bsh/scribbit-mint/src/services/types';
import type { PlaygroundWallet, Services, WalletSession } from '../services/types';

export const POSTAGE = 546n;

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  sample: boolean;
}

export interface Plan {
  file: PickedFile;
  feeRate: number;
  quote: RevealQuote;
  commitAddress: string;
  funding: { psbtBase64: string; txid: string; commitVout: number; selection: CoinSelection; inputsToSign: Array<{ index: number; address: string }> };
  reveal: { psbtBase64: string; leafScriptHex: string };
  /** commit value + funding fee: everything the wallet pays. */
  totalSats: number;
}

export interface CommitResult {
  txid: string;
  vsize: number;
  fee: number;
}

export interface RevealResult {
  txid: string;
  weight: number;
  vsize: number;
  inscriptionId: string;
}

/** Real wallets through wallet-kit become PlaygroundWallets; the leaf key follows the mint's per-wallet plan. */
export function externalWallet(session: WalletSession): PlaygroundWallet {
  return { kind: 'external', name: session.name, ordinals: session.ordinals, payment: session.payment, plan: planRevealSigning(session), signPsbt: (p, r) => session.signPsbt(p, r), session };
}

export function toContent(file: PickedFile): InscriptionContent {
  return { contentType: file.contentType, body: file.bytes instanceof Uint8Array ? Uint8Array.from(file.bytes) : file.bytes };
}

export async function quoteFile(services: Services, args: { wallet: PlaygroundWallet; file: PickedFile; feeRate: number }): Promise<Plan> {
  const content = toContent(args.file);
  const q = services.inscription.quote({ content, recipientAddress: args.wallet.ordinals.address, network: 'signet', feeRate: args.feeRate, postage: POSTAGE });
  if (q.lane !== 'standard') throw new UserFacingError(`This file makes a ${q.weight.toLocaleString('en-US')} WU reveal, above the 400,000 WU standard limit.`, 'Pick a smaller file: the playground only uses the standard lane.');
  const commitAddress = services.inscription.commitAddress(args.wallet.plan.leafPubkey, content, 'signet');
  const utxos = await services.chain.getUtxos(args.wallet.payment.address);
  const funding = buildFundingPsbt({
    network: 'signet',
    utxos,
    payment: args.wallet.payment,
    ordinalsAddress: args.wallet.ordinals.address,
    commitAddress,
    commitValue: Number(q.commitValue),
    feeRate: args.feeRate,
  });
  const reveal = services.inscription.buildUnsignedReveal({
    network: 'signet',
    leafPubkey: args.wallet.plan.leafPubkey,
    content,
    commitOutpoint: { txid: funding.txid, vout: funding.commitVout },
    commitValue: q.commitValue,
    recipientAddress: args.wallet.ordinals.address,
    postage: POSTAGE,
    sighash: args.wallet.plan.sighash,
  });
  if (reveal.commitAddress !== commitAddress) throw new Error('commit address drift between quote and reveal (bug)');
  return {
    file: args.file,
    feeRate: args.feeRate,
    quote: q,
    commitAddress,
    funding,
    reveal: { psbtBase64: reveal.psbtBase64, leafScriptHex: reveal.leafScriptHex },
    totalSats: Number(q.commitValue) + funding.selection.fee,
  };
}

export async function commit(services: Services, wallet: PlaygroundWallet, plan: Plan): Promise<CommitResult> {
  const signed = await wallet.signPsbt(plan.funding.psbtBase64, { inputsToSign: plan.funding.inputsToSign, finalize: false, broadcast: false, inscription: { envelopeScriptHex: plan.reveal.leafScriptHex, commitAddress: plan.commitAddress } });
  const { hex } = assertTxidUnchanged(signed.psbtBase64, plan.funding.txid);
  const txid = await services.chain.broadcast(hex);
  if (txid !== plan.funding.txid) throw new UserFacingError(`The node reported txid ${txid}, not the expected ${plan.funding.txid}.`, 'Do not sign anything else; check both ids on the explorer.');
  return { txid, vsize: plan.funding.selection.vsize, fee: plan.funding.selection.fee };
}

export async function reveal(services: Services, wallet: PlaygroundWallet, plan: Plan): Promise<RevealResult> {
  const signed = await wallet.signPsbt(plan.reveal.psbtBase64, { inputsToSign: [wallet.plan.inputToSign], finalize: false, broadcast: false, inscription: { envelopeScriptHex: plan.reveal.leafScriptHex, commitAddress: plan.commitAddress } });
  const final = services.inscription.finalizeWalletSignedReveal(signed.psbtBase64);
  const txid = await services.chain.broadcast(final.hex);
  if (txid !== final.txid) throw new UserFacingError(`The node reported txid ${txid}, not ${final.txid}.`, 'Check both on the explorer before signing again.');
  return { txid, weight: final.weight, vsize: final.vsize, inscriptionId: `${final.txid}i0` };
}
