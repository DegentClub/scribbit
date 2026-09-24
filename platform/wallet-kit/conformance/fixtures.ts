/**
 * Fixtures for the conformance lab. Generated with @scure/btc-signer from throwaway private keys
 * (0x11.., 0x22.., 0x33.., 0x44.. repeated) — never funded, never to be funded. Addresses are checksum-valid;
 * the PSBT spends one P2WPKH input (index 0, sighashType 0x81 = ALL|ANYONECANPAY) to the ordinals P2TR;
 * the raw tx is that same spend fully signed, usable only for a pushTx DRY RUN (the outpoint does not exist).
 */
export interface FixtureAccount { address: string; publicKey: string }
export interface NetworkFixture { ordinals: FixtureAccount; payment: FixtureAccount; ordinals2: FixtureAccount; payment2: FixtureAccount; psbtBase64: string; rawTxHex: string }
export const FIXTURES: Record<"signet" | "mainnet", NetworkFixture> = {
  signet: {
    ordinals: {
      address: "tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj",
      publicKey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"
    },
    payment: {
      address: "tb1q2vfxp232rx0z9rzn0hay9jptagk8c86d0gwv99",
      publicKey: "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"
    },
    ordinals2: {
      address: "tb1plr5908qjdayaa5ehcxwy7hcur9glqafpvtt2v8c2nc24s4v5899seky47r",
      publicKey: "3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"
    },
    payment2: {
      address: "tb1qesds0quw8p774ngw2gewr695naxzneyyc2yq7g",
      publicKey: "032c0b7cf95324a07d05398b240174dc0c2be444d96b159aa6c7f7b1e668680991"
    },
    psbtBase64: "cHNidP8BAF4CAAAAAaurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urAQAAAAD/////AThKAAAAAAAAIlEgKmSx7jN187tLNnuMuDhKR/c88jFxf4J8bG+79a7PDDYAAAAAAAEBHyBOAAAAAAAAFgAUUxJgqioZniKMU336Qsgr6ix8H00BAwSBAAAAAAA=",
    rawTxHex: "02000000000101abababababababababababababababababababababababababababababababab0100000000ffffffff01384a0000000000002251202a64b1ee3375f3bb4b367b8cb8384a47f73cf231717f827c6c6fbbf5aecf0c360248304502210086dfbf343ea495909b674912e0c87ab1c32b1046da850c1dd548bf568327c48402205a5c1bcfd86d715cce3b185a9feaeecce89d99034555a7e48e4b3bd3e1d841fa012102466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f2700000000"
  },
  mainnet: {
    ordinals: {
      address: "bc1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmq6cnwza",
      publicKey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"
    },
    payment: {
      address: "bc1q2vfxp232rx0z9rzn0hay9jptagk8c86d9w4l7k",
      publicKey: "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"
    },
    ordinals2: {
      address: "bc1plr5908qjdayaa5ehcxwy7hcur9glqafpvtt2v8c2nc24s4v5899sw7j6yv",
      publicKey: "3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"
    },
    payment2: {
      address: "bc1qesds0quw8p774ngw2gewr695naxzneyyjvln9m",
      publicKey: "032c0b7cf95324a07d05398b240174dc0c2be444d96b159aa6c7f7b1e668680991"
    },
    psbtBase64: "cHNidP8BAF4CAAAAAaurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urAQAAAAD/////AThKAAAAAAAAIlEgKmSx7jN187tLNnuMuDhKR/c88jFxf4J8bG+79a7PDDYAAAAAAAEBHyBOAAAAAAAAFgAUUxJgqioZniKMU336Qsgr6ix8H00BAwSBAAAAAAA=",
    rawTxHex: "02000000000101abababababababababababababababababababababababababababababababab0100000000ffffffff01384a0000000000002251202a64b1ee3375f3bb4b367b8cb8384a47f73cf231717f827c6c6fbbf5aecf0c360248304502210086dfbf343ea495909b674912e0c87ab1c32b1046da850c1dd548bf568327c48402205a5c1bcfd86d715cce3b185a9feaeecce89d99034555a7e48e4b3bd3e1d841fa012102466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f2700000000"
  }
};

export const SIGN_MESSAGE = "wallet-kit conformance: sign this message to prove control of the address";
/** A stand-in signature the fakes return; real wallets return base64 BIP-322 / ECDSA signatures. */
export const FAKE_SIGNATURE = "AkgwRQIhAPfake-signature-base64=";
export const FAKE_TXID = "ab".repeat(32);
