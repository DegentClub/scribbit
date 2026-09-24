import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { Address, NETWORK, p2tr, TEST_NETWORK, utils } from '@scure/btc-signer';
import {
  ADAPTERS,
  CAPABILITIES,
  WALLET_IDS,
  deriveTaprootOutputKey,
  getAdapter,
  taprootOutputKeyOf,
  taprootOutputKeyOfAddress,
  unisatAdapter,
  xOnlyPubkey,
  type WalletId,
} from '../src/index.js';
import { ADDR, Recorder, SIGNED_HEX, UNSIGNED_B64, win } from './helpers.js';

describe('capabilities table', () => {
  it('covers every registered wallet with the four fields', () => {
    expect(WALLET_IDS).toEqual(['unisat', 'xverse', 'leather', 'okx', 'magiceden', 'xcp', 'horizon']);
    for (const id of WALLET_IDS) {
      const c = CAPABILITIES[id];
      expect(typeof c.broadcast).toBe('boolean');
      expect(typeof c.bip322).toBe('boolean');
      expect([true, false, 'unknown']).toContain(c.tapscript);
      expect([true, false, 'unknown']).toContain(c.tweakedLeafKey);
      expect(getAdapter(id)).toBe(ADAPTERS.find((a) => a.id === id));
    }
  });

  it('pins the documented rows', () => {
    const rows: Record<WalletId, [boolean, boolean, boolean | 'unknown', boolean | 'unknown']> = {
      unisat: [true, true, true, true],
      okx: [true, true, 'unknown', 'unknown'],
      xverse: [true, true, true, false],
      magiceden: [true, true, 'unknown', 'unknown'],
      leather: [true, true, 'unknown', 'unknown'],
      xcp: [true, true, true, true],
      horizon: [false, false, true, true],
    };
    for (const [id, [broadcast, bip322, tapscript, tweakedLeafKey]] of Object.entries(rows) as [WalletId, (typeof rows)[WalletId]][]) {
      expect(CAPABILITIES[id]).toEqual({ broadcast, bip322, tapscript, tweakedLeafKey });
    }
  });
});

describe('taproot output key derivation', () => {
  const priv = hex.decode('04'.repeat(32));
  const internal = utils.pubSchnorr(priv);
  const compressed = '02' + hex.encode(internal); // as a wallet reports it (parity byte irrelevant for x-only)

  it('xOnlyPubkey strips the parity byte and rejects other shapes', () => {
    expect(xOnlyPubkey(compressed)).toEqual(internal);
    expect(xOnlyPubkey('03' + hex.encode(internal))).toEqual(internal);
    expect(xOnlyPubkey(hex.encode(internal))).toEqual(internal);
    expect(xOnlyPubkey('04' + '00'.repeat(64))).toBeUndefined();
    expect(xOnlyPubkey('zz')).toBeUndefined();
    expect(xOnlyPubkey('')).toBeUndefined();
  });

  it.each([
    ['mainnet', NETWORK],
    ['testnet', TEST_NETWORK],
  ] as const)('deriveTaprootOutputKey(pubkey) == program of the BIP86 p2tr address (%s)', (_name, net) => {
    const pay = p2tr(internal, undefined, net);
    const derived = deriveTaprootOutputKey(compressed);
    expect(derived).toBe(hex.encode(pay.tweakedPubkey));
    expect(derived).toBe(taprootOutputKeyOfAddress(pay.address!));
    const decoded = Address(net).decode(pay.address!) as { type: string; pubkey: Uint8Array };
    expect(decoded.type).toBe('tr');
    expect(derived).toBe(hex.encode(decoded.pubkey));
    expect(derived).not.toBe(hex.encode(internal));
    expect(derived).toBe(taprootOutputKeyOf({ address: pay.address!, publicKey: compressed, purpose: 'ordinals', addressType: 'p2tr' }));
  });

  it('is undefined for non-p2tr addresses and garbage', () => {
    expect(taprootOutputKeyOfAddress(ADDR.main.p2wpkh)).toBeUndefined();
    expect(taprootOutputKeyOfAddress(ADDR.main.p2sh)).toBeUndefined();
    expect(taprootOutputKeyOfAddress('bc1p' + 'q'.repeat(58))).toBeUndefined();
    expect(deriveTaprootOutputKey('')).toBeUndefined();
  });

  it('a connected wallet exposes taprootOutputKey for its p2tr ordinals account (UniSat) and disableTweak → disableTweakSigner', async () => {
    const pay = p2tr(internal, undefined, NETWORK);
    const rec = new Recorder();
    win().unisat = {
      async requestAccounts() {
        return [pay.address];
      },
      async getPublicKey() {
        return compressed;
      },
      async getChain() {
        return { enum: 'BITCOIN_MAINNET' };
      },
      async switchChain() {
        return { enum: 'BITCOIN_MAINNET' };
      },
      async signPsbt(h: string, o: unknown) {
        rec.record('signPsbt', [h, o]);
        return SIGNED_HEX;
      },
      async signMessage() {
        return 'sig';
      },
    };
    const w = await unisatAdapter.connect({ network: 'mainnet' });
    expect(w.taprootOutputKey).toBe(hex.encode(pay.tweakedPubkey));
    expect(w.taprootOutputKey).toBe(deriveTaprootOutputKey(w.ordinals.publicKey));
    expect(w.capabilities).toBe(CAPABILITIES.unisat);
    await w.signPsbt(UNSIGNED_B64, {
      inputsToSign: [
        { index: 0, address: pay.address!, disableTweak: true },
        { index: 1, address: pay.address!, disableTweak: false, sighashTypes: [0x81] },
        { index: 2, address: pay.address! },
      ],
    });
    expect((rec.last('signPsbt')?.args[1] as { toSignInputs: unknown[] }).toSignInputs).toEqual([
      { index: 0, address: pay.address, disableTweakSigner: true },
      { index: 1, address: pay.address, sighashTypes: [0x81], disableTweakSigner: false },
      { index: 2, address: pay.address },
    ]);
  });
});
