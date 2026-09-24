import { Address, NETWORK, OutScript, TEST_NETWORK } from '@scure/btc-signer';

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface BtcNetworkParams {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

const REGTEST: BtcNetworkParams = Object.freeze({ bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef });

/** btc-signer network parameters for a network name. */
export function networkParams(network: Network): BtcNetworkParams {
  switch (network) {
    case 'mainnet':
      return NETWORK;
    case 'testnet':
    case 'signet':
      return TEST_NETWORK;
    case 'regtest':
      return REGTEST;
    default:
      throw new Error(`unknown network: ${String(network)}`);
  }
}

/** scriptPubKey for an address on the given network (throws on a wrong network or an invalid address). */
export function addressToScript(address: string, network: Network): Uint8Array {
  const decoded = Address(networkParams(network)).decode(address);
  return OutScript.encode(decoded as Parameters<typeof OutScript.encode>[0]);
}

/** Address for a scriptPubKey, or null when the script has no address form (OP_RETURN, bare scripts). */
export function scriptToAddress(script: Uint8Array, network: Network): string | null {
  try {
    const decoded = OutScript.decode(script);
    if (decoded.type === 'unknown' || decoded.type === 'pk' || decoded.type === 'ms' || decoded.type === 'tr_ns' || decoded.type === 'tr_ms')
      return null;
    return Address(networkParams(network)).encode(decoded as Parameters<ReturnType<typeof Address>['encode']>[0]);
  } catch {
    return null;
  }
}
