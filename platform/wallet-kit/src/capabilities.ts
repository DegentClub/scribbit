import type { WalletCapabilities, WalletId } from './types.js';

/**
 * Per-wallet capability table. VERIFIED / ASSUMED provenance is in the README ("Capabilities");
 * anything without reference code is `'unknown'` rather than a guess.
 */
export const CAPABILITIES: Readonly<Record<WalletId, Readonly<WalletCapabilities>>> = Object.freeze({
  // signPsbt + pushPsbt/pushTx; signMessage bip322-simple; tapscript via toSignInputs
  // (`disableTweakSigner` exists precisely to pick the leaf key); tweaked by default.
  unisat: Object.freeze({ broadcast: true, bip322: true, tapscript: true, tweakedLeafKey: true }),
  // UniSat-compatible API; no reference code exercises tapscript.
  okx: Object.freeze({ broadcast: true, bip322: true, tapscript: 'unknown', tweakedLeafKey: 'unknown' }),
  // sats-connect signPsbt with tapLeafScript inputs (bitcoinjs: leaves are signed with the untweaked key).
  xverse: Object.freeze({ broadcast: true, bip322: true, tapscript: true, tweakedLeafKey: false }),
  magiceden: Object.freeze({ broadcast: true, bip322: true, tapscript: 'unknown', tweakedLeafKey: 'unknown' }),
  leather: Object.freeze({ broadcast: true, bip322: true, tapscript: 'unknown', tweakedLeafKey: 'unknown' }),
  // counters.fun: signs the re-keyed ord envelope's script path with the tweaked key; BIP-322 proof on connect;
  // xcp_broadcastTransaction.
  xcp: Object.freeze({ broadcast: true, bip322: true, tapscript: true, tweakedLeafKey: true }),
  // counters.fun: handles tapLeafScript/tapInternalKey, no relay, ECDSA/BIP-137 messages only.
  horizon: Object.freeze({ broadcast: false, bip322: false, tapscript: true, tweakedLeafKey: true }),
});
