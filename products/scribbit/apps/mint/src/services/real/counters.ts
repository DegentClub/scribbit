/**
 * Real counters ports over @bsh/scribbit-counters: the CpClient talks to the mint API's allowlisted
 * Counterparty proxy; the CountersKit is the engine's pure maths (also used in demo mode: only I/O is faked).
 */
import * as ck from '@bsh/scribbit-counters';
import { hex } from '@scure/base';
import type { AssetNameCheck, CountersKit, CpClient } from '../types';

export function createRealCp(mintApiUrl: string, fetchImpl?: typeof fetch): CpClient {
  const client = ck.createCpClient({ baseUrl: `${mintApiUrl.replace(/\/+$/, '')}/api/cp`, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return {
    async getAsset(name) {
      const a = await client.getAsset(name);
      return a ? { asset: a.asset, owner: a.owner, divisible: a.divisible, locked: a.locked, descriptionLocked: a.description_locked === true, supply: ck.big(a.supply) } : null;
    },
    getBalance: (address, asset) => client.getBalance(address, asset),
    async getOwnedAssets(address) {
      const rows = await client.getOwnedAssets(address);
      return rows.map((r) => ({ asset: r.asset, divisible: r.divisible, descriptionLocked: r.description_locked, mimeType: r.mime_type }));
    },
    getTip: () => client.getTip(),
    compose: (address, type, params) => client.compose(address, type, params),
    broadcast: (h) => client.broadcast(h),
    knowsTx: (txid) => client.knowsTransaction(txid),
  };
}

const REASONS: Record<string, string> = {
  reserved: 'BTC and XCP are reserved.',
  'numeric-out-of-range': 'A numeric name is A followed by an integer between 26^12+1 and 2^64-1.',
  'named-shape': 'A named asset is 4 to 12 uppercase letters and cannot start with A.',
  'subasset-parent': 'The part before the dot must be a valid named or numeric asset (not itself a subasset).',
  'subasset-child': 'The part after the dot may use letters, digits and . - _ @ !',
  'subasset-length': 'A subasset name is at most 250 characters.',
};

export function createRealCountersKit(): CountersKit {
  return {
    STANDARD_WITNESS_LIMIT_WU: ck.STANDARD_WITNESS_LIMIT_WU,
    checkAssetName(name): AssetNameCheck {
      const kind = ck.classifyAssetName(name);
      if (kind === 'invalid') {
        // Re-derive the node's reason with the same rules the engine applies.
        const n = name.trim();
        const reason = n === 'BTC' || n === 'XCP' ? 'reserved' : n.includes('.') ? (n.length > 250 ? 'subasset-length' : /^[A-Z0-9]+\./.test(n) ? 'subasset-child' : 'subasset-parent') : /^A\d*$/.test(n) ? 'numeric-out-of-range' : 'named-shape';
        return { ok: false, reason: REASONS[reason] ?? 'Not a valid asset name.' };
      }
      const dot = name.indexOf('.');
      return kind === 'subasset' ? { ok: true, kind, parent: name.slice(0, dot) } : { ok: true, kind };
    },
    randomNumericAsset: ck.randomNumericAsset,
    issuanceBurnXcp: ck.issuanceBurnXcp,
    encodeContent(body, mimeType) {
      const e = ck.encodeContent(body, mimeType);
      return { description: e.description, classification: e.kind };
    },
    estimate(args) {
      const e = ck.estimateMint({ bytes: args.bytes, feeRate: args.feeRate, kind: args.kind, ...(args.assetName ? { assetName: args.assetName } : {}), ...(args.mimeType ? { mimeType: args.mimeType } : {}), ...(args.quantity !== undefined ? { quantity: args.quantity } : {}), ...(args.fairminter ? { fairminter: args.fairminter } : {}) });
      return { revealWeight: e.revealWeight, revealVsize: e.revealVsize, revealFee: e.revealFee, commitValue: e.commitValue, revealOutputs: e.revealOutputs, xcpBurn: e.xcpBurn, standardRelay: e.standardRelay };
    },
    xcp69Params: ck.xcp69Params,
    xcp69Schedule: (tip, lead) => ck.xcp69Schedule(tip, lead),
    routeFit: ck.routeFitForWeight,
    fairminterProblems: ck.fairminterProblems,
    fairminterComposeParams: ck.fairminterComposeParams,
    revealWeightOf: (compose) => ck.revealWeightOf(compose, 'all'),
    commitTopUp: ck.commitTopUp,
    buildCommitPsbt({ network, compose, leafKey32, topUpSats }) {
      // Core's own inputs and change are reused (it selected and priced them); the top-up moves sats from
      // Core's change into the commit so the miner fee is unchanged.
      const c = ck.buildCommitPsbt({ network, compose, leafKey32, utxos: [], changeAddress: '', feeRate: 1, topUpSats });
      return { psbtBase64: c.psbtBase64, commitValue: c.commitValue, commitVout: c.commitVout, inputsToSign: c.inputsToSign, commitAddress: c.commit.address, leafHex: hex.encode(c.commit.leaf), fee: c.fee };
    },
    buildRevealPsbt(args) {
      const r = ck.buildRevealPsbt({ ...args, sighash: 'all' });
      return { psbtBase64: r.psbtBase64, inputIndex: r.inputIndex };
    },
    finalize: ck.finalize,
    unsignedRevealTxid: ck.unsignedRevealTxid,
  };
}

/** Compose parameters shared by every mode, as the engine names them. */
export const composeCommon = ck.commonComposeParams;
export const composeSupply = ck.supplyParams;
