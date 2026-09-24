/** Real InscriptionOps: @bsh/inscription, the same code the CLI and MCP server quote with. */
import * as ins from '@bsh/inscription';
import { hex } from '@scure/base';
import type { InscriptionOps } from '../types';

export function createRealInscription(): InscriptionOps {
  return {
    sha256Hex: ins.sha256Hex,
    commitAddress: (leafPubkey, content, network) => ins.commitAddress(leafPubkey, content, network).address,
    quote({ content, recipientAddress, network, feeRate, postage }) {
      const recipientScript = ins.addressToScript(recipientAddress, network);
      const weight = ins.estimateRevealWeight({ content, withParent: false, recipientScript, commitSighash: 'default' });
      const q = ins.quoteReveal({ revealWeight: weight, feeRate, postage });
      return { weight, vsize: q.revealVsize, lane: ins.laneFor(weight), revealFee: q.revealFee, commitValue: q.commitValue };
    },
    buildUnsignedReveal(args) {
      const r = ins.buildUnsignedRevealPsbt({ ...args, withParent: false, sighash: args.sighash ?? 'default' });
      return { psbtBase64: r.psbtBase64, inputIndex: r.inputIndex, leafScriptHex: hex.encode(r.leafScript), commitAddress: r.commitAddress };
    },
    buildUnsignedRescue(args) {
      const r = ins.buildUnsignedRescuePsbt(args);
      return { psbtBase64: r.psbtBase64, inputIndex: r.inputIndex, fee: r.fee };
    },
    finalizeWalletSignedReveal: ins.finalizeWalletSignedReveal,
  };
}
