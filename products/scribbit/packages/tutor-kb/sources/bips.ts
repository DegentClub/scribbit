/**
 * Hand-written summaries of the canonical Bitcoin specifications the tutor cites most, with a citation to the
 * BIP number (and the ordinals docs for the envelope). These are OUR summaries of primary documents, not
 * verbatim excerpts, so they are labelled `authored: true` and every factual claim is one a reader can check
 * against the cited source. Numbers here are consensus / standard-policy facts (see root CLAUDE.md #4).
 */
export interface AuthoredSource {
  id: string;
  title: string;
  text: string;
  url: string;
  bip?: string;
  tags: string[];
}

export const BIP_SOURCES: readonly AuthoredSource[] = Object.freeze([
  {
    id: 'bip340',
    bip: 'BIP340',
    title: 'BIP340 — Schnorr signatures for secp256k1',
    url: 'https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki',
    tags: ['schnorr', 'signature', 'taproot', 'crypto', 'protocols'],
    text:
      'BIP340 defines Schnorr signatures over the secp256k1 curve, the signature scheme Taproot spends use. ' +
      'A signature is 64 bytes: a 32-byte x-only public key point R and a 32-byte scalar s; public keys are the ' +
      '32-byte x-only encoding (the y coordinate is taken to be even). Schnorr signatures are linear, which makes ' +
      'key and signature aggregation (many signers producing one signature) possible, and they are provably secure ' +
      'under simpler assumptions than ECDSA. The message is hashed with a tagged hash (BIP340 defines the ' +
      'tagged-hash construction) so signatures for one purpose cannot be replayed for another. scribb.it reveal ' +
      'transactions are Taproot script-path spends and therefore carry BIP340 Schnorr signatures in their witness.',
  },
  {
    id: 'bip341',
    bip: 'BIP341',
    title: 'BIP341 — Taproot: SegWit version 1 spending rules',
    url: 'https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki',
    tags: ['taproot', 'p2tr', 'script-path', 'key-path', 'merkle', 'scripts'],
    text:
      'BIP341 defines Taproot, SegWit version 1 outputs (P2TR, addresses starting bc1p / tb1p). The output ' +
      'commits to an internal public key tweaked by the merkle root of a tree of alternative scripts. It can be ' +
      'spent two ways: a key-path spend, a single Schnorr signature against the tweaked key that reveals no ' +
      'scripts and is indistinguishable from an ordinary payment; or a script-path spend, which reveals one leaf ' +
      'script, the leaf version, and a control block proving the leaf is in the committed tree. The control block ' +
      'is 33 bytes plus 32 bytes per merkle sibling. Inscriptions use a script-path spend: the inscription ' +
      'envelope is the revealed leaf script, and the internal key is a fixed unspendable NUMS point so the only ' +
      'way to spend is to reveal the envelope. Taproot uses the BIP340 Schnorr scheme for its signatures.',
  },
  {
    id: 'bip342',
    bip: 'BIP342',
    title: 'BIP342 — Tapscript: validation of Taproot leaf scripts',
    url: 'https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki',
    tags: ['tapscript', 'script', 'opcodes', 'push-limit', 'scripts'],
    text:
      'BIP342 (Tapscript) is the script language used inside a Taproot script-path spend. It keeps most of the ' +
      'legacy Bitcoin Script opcodes but changes signature checking to use Schnorr (BIP340) and replaces ' +
      'OP_CHECKMULTISIG with OP_CHECKSIGADD. Crucially for inscriptions, Tapscript removes the 10,000-byte script ' +
      'size limit that applied to legacy scripts: a tapscript can be arbitrarily large, bounded only by the ' +
      'transaction weight limits. Individual data pushes are still limited to 520 bytes (the script element size ' +
      'limit), so an inscription body larger than 520 bytes is split across many OP_PUSHBYTES pushes inside one ' +
      'OP_FALSE OP_IF … OP_ENDIF envelope. This is what lets an inscription carry megabytes of data in a single ' +
      'leaf script.',
  },
  {
    id: 'ordinals-envelope',
    title: 'Ordinals inscription envelope',
    url: 'https://docs.ordinals.com/inscriptions.html',
    tags: ['inscription', 'envelope', 'ordinals', 'tapscript', 'inscriptions'],
    text:
      'An ordinals inscription is data embedded in a Taproot tapscript "envelope": the pattern OP_FALSE OP_IF, a ' +
      'series of tagged pushes, then OP_ENDIF, wrapped in a script the OP_IF branch never executes so the data is ' +
      'inert and costs only witness weight. Tag 1 is the content type (a MIME string), the body follows an empty ' +
      'data push and is chunked into pushes of at most 520 bytes each. Optional tags include the parent (tag 3, ' +
      'linking a child to a parent inscription for provenance), metadata (tag 5, CBOR), a pointer, a content ' +
      'encoding, and a delegate. Because witness bytes weigh one weight unit instead of four, putting the data in ' +
      'the reveal witness is the cheapest place to write it. The inscription is created in two transactions: a ' +
      'commit that pays to the envelope’s Taproot address, and a reveal that spends it and exposes the envelope.',
  },
]);
