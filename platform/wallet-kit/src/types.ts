/**
 * Provider-agnostic wallet surface. Every adapter normalises its browser
 * extension to these shapes, so mint code never branches on wallet id.
 *
 * Conventions:
 * - PSBTs cross this boundary as **base64**. Adapters convert to hex for the
 *   wallets that want hex (UniSat, OKX, Leather).
 * - Public keys are hex strings exactly as the wallet reports them.
 * - `testnet` means **testnet4** wherever a wallet distinguishes testnet3 from
 *   testnet4 (UniSat, Xverse). See README for per-wallet caveats.
 */

export type WalletId = 'unisat' | 'xverse' | 'leather' | 'okx' | 'magiceden' | 'xcp' | 'horizon';

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export type AddressType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'unknown';

export type AddressPurpose = 'ordinals' | 'payment';

export interface WalletAccount {
  address: string;
  /** Hex, as reported by the wallet (compressed 33-byte key or x-only 32-byte key). */
  publicKey: string;
  purpose: AddressPurpose;
  addressType: AddressType;
}

export interface InputToSign {
  index: number;
  /** The wallet address that owns this input. Must be the ordinals or payment address. */
  address: string;
  /** Allowed sighash types. Forwarded where the wallet supports it (see README). */
  sighashTypes?: number[];
  /**
   * Sign this input with the untweaked internal key instead of the tweaked taproot key
   * (UniSat/OKX `disableTweakSigner`). Needed when a tapscript leaf names the wallet's internal
   * x-only key (`LeafKeyKind = 'internal'` in @bsh/inscription). Ignored by wallets without the option.
   */
  disableTweak?: boolean;
}

/**
 * What an inscription commit is for, for wallets that refuse to sign BTC movement they cannot
 * account for (XCP Wallet's inscription gate). `envelopeScriptHex` is the reveal's tapleaf (the
 * ord envelope whose OP_CHECKSIG key is the signer's own taproot output key); `commitAddress` is
 * the P2TR(NUMS, leaf) address the commit pays. Other wallets ignore it.
 */
export interface InscriptionContext {
  envelopeScriptHex: string;
  commitAddress: string;
}

export interface SignPsbtOptions {
  inputsToSign: InputToSign[];
  /** Ask the wallet to finalize signed inputs. Default false. Forced true when `broadcast` is set. */
  finalize?: boolean;
  /** Ask the wallet to broadcast the finalized transaction. Default false. */
  broadcast?: boolean;
  /** Inscription commit context; required by XCP Wallet to sign a commit, ignored elsewhere. */
  inscription?: InscriptionContext;
}

export interface SignPsbtResult {
  psbtBase64: string;
  /** Present when `broadcast` was requested and the wallet reported the txid. */
  txid?: string;
}

export type MessageSignatureType = 'bip322-simple' | 'ecdsa';

/**
 * What a wallet can do, as far as we know. `'unknown'` means no reference code or documentation
 * settles it (see README "Verified vs assumed"); treat it as "try, and handle UNSUPPORTED_METHOD".
 */
export interface WalletCapabilities {
  /** Can relay a signed transaction itself (`broadcast: true` in signPsbt and/or `pushTx`). */
  broadcast: boolean;
  /** Signs BIP-322 messages. */
  bip322: boolean;
  /** Signs a taproot script-path (tapscript leaf) input from PSBT_IN_TAP_LEAF_SCRIPT. */
  tapscript: boolean | 'unknown';
  /**
   * When signing a tapscript leaf, the wallet signs with its **tweaked** taproot output key
   * (`taprootOutputKey`) rather than the untweaked internal key. Decides `LeafKeyKind` in
   * @bsh/inscription: true → `'output'`, false → `'internal'`. UniSat/OKX can do either
   * (`disableTweak` per input).
   */
  tweakedLeafKey: boolean | 'unknown';
}

export interface ConnectedWallet {
  id: WalletId;
  network: Network;
  ordinals: WalletAccount;
  payment: WalletAccount;
  capabilities: WalletCapabilities;
  /**
   * The x-only **tweaked** taproot output key of the ordinals account: the 32-byte witness
   * program of its bc1p address, hex. Present when the ordinals address is p2tr. This is the key
   * an inscription leaf must name for wallets with `tweakedLeafKey: true` (XCP Wallet verifies
   * the leaf against exactly this value).
   */
  taprootOutputKey?: string;
  signPsbt(psbtBase64: string, opts: SignPsbtOptions): Promise<SignPsbtResult>;
  signMessage(message: string, address: string, type?: MessageSignatureType): Promise<string>;
  /** Broadcast a raw transaction through the wallet. Only on wallets that can relay. */
  pushTx?(hex: string): Promise<string>;
  disconnect(): Promise<void>;
  /**
   * Subscribe to the wallet switching account/network underneath us. Only on
   * wallets that emit such events. Returns an unsubscribe function.
   */
  onAccountsChanged?(cb: () => void): () => void;
}

export interface ConnectOptions {
  network: Network;
}

export interface WalletAdapter {
  id: WalletId;
  name: string;
  icon?: string;
  installUrl: string;
  /** Networks this adapter can connect to. `connect` throws UnsupportedNetworkError otherwise. */
  networks: readonly Network[];
  isInstalled(): boolean;
  connect(opts: ConnectOptions): Promise<ConnectedWallet>;
}
