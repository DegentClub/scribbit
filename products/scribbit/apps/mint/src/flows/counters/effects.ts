/**
 * Counters mint effects, against the service ports. The engine (@bsh/scribbit-counters) does the maths;
 * this file decides the order and the checks:
 *
 *   preflight:  name shape → existence/ownership (cp) → 0.5 XCP burn vs balance → BTC at the address →
 *               reveal weight vs the 400k WU relay cap (Slipstream offered when over)
 *   mint:       compose via the proxy → exact reveal weight → re-key the envelope to the wallet's leaf key →
 *               commit PSBT (+ SIGHASH_ALL top-up) → wallet signs (XCP Wallet with the inscription context) →
 *               txid unchanged? → reveal PSBT → PENDING SAVED → broadcast commit → sign reveal → broadcast
 *   resume:     sign the saved reveal PSBT again and broadcast
 */
import type { Network } from '@bsh/inscription';
import type { AssetInfo, CountersKit, FairminterParams, MintKind, Services, WalletSession } from '../../services/types';
import { isUnverified, planRevealSigning, UNVERIFIED_COPY } from '../../lib/walletRouting';
import { savePendingCounters, clearPendingCounters, type KeyValueStore, type PendingCounters } from '../../lib/pending';
import { UserFacingError } from '../../lib/errors';
import { TxidMismatchError } from '../../lib/funding';
import type { CountersResult, CountersStage } from './state';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'pending' | 'skip';
export interface PreflightCheck {
  id: 'wallet' | 'name' | 'existence' | 'burn' | 'btc' | 'weight' | 'sale';
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CountersForm {
  kind: MintKind;
  asset: string;
  bytes: Uint8Array | null;
  mimeType: string;
  feeRate: number | null;
  quantity: bigint;
  divisible: boolean;
  lockQuantity: boolean;
  ordWrapper: boolean;
  preset: 'xcp69' | 'custom';
  fairminter: FairminterParams | null;
  route: 'public' | 'slipstream';
}

export interface PreflightFacts {
  wallet: WalletSession | null;
  /** undefined = not looked up yet; null = nobody issued it; 'error' = could not ask. */
  existing: AssetInfo | null | undefined | 'error';
  xcpBalance: bigint | null | 'error';
  btcAvailable: number | null | 'error';
}

const XCP = (raw: bigint) => `${(Number(raw) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} XCP`;

/** The pre-flight table, in the order the mint checks. Pure: the lookups are passed in. */
export function preflight(kit: CountersKit, form: CountersForm, facts: PreflightFacts): { checks: PreflightCheck[]; estimate: ReturnType<CountersKit['estimate']> | null; ready: boolean; blocker: string | null } {
  const checks: PreflightCheck[] = [];
  const w = facts.wallet;
  checks.push(
    !w
      ? { id: 'wallet', label: 'Wallet', status: 'fail', detail: 'Connect a wallet.' }
      : w.ordinals.addressType !== 'p2tr'
        ? { id: 'wallet', label: 'Wallet', status: 'fail', detail: `Minting needs a taproot address; ${w.ordinals.address} is ${w.ordinals.addressType}.` }
        : w.capabilities.tapscript === false
          ? { id: 'wallet', label: 'Wallet', status: 'fail', detail: `${w.name} cannot sign the reveal (tapscript).` }
          : isUnverified(w.id, w.capabilities)
            ? { id: 'wallet', label: 'Wallet', status: 'warn', detail: `${w.name} · ${w.ordinals.address} · reveal signing ${UNVERIFIED_COPY}.` }
            : { id: 'wallet', label: 'Wallet', status: 'ok', detail: `${w.name} · ${w.ordinals.address}` },
  );

  const name = form.asset.trim();
  let burn = 0n;
  if (!name) {
    checks.push(form.kind === 'reinscription' ? { id: 'name', label: 'Asset name', status: 'fail', detail: 'A reinscription needs an asset you own.' } : { id: 'name', label: 'Asset name', status: 'ok', detail: 'Empty: a free numeric name (A…) will be drawn in your browser.' });
  } else {
    const c = kit.checkAssetName(name);
    if (!c.ok) checks.push({ id: 'name', label: 'Asset name', status: 'fail', detail: c.reason });
    else if (form.kind === 'fairminter' && c.kind === 'subasset') checks.push({ id: 'name', label: 'Asset name', status: 'fail', detail: 'A fairminter cannot deploy a subasset.' });
    else {
      checks.push({ id: 'name', label: 'Asset name', status: 'ok', detail: c.kind === 'named' ? 'Named asset.' : c.kind === 'numeric' ? 'Numeric asset (free).' : `Subasset of ${c.parent} (free; you must own ${c.parent}).` });
      if (form.kind !== 'reinscription') burn = kit.issuanceBurnXcp(name);
    }
  }

  // Existence
  if (name && checks[1]!.status === 'ok') {
    const ex = facts.existing;
    const mine = ex && ex !== 'error' && w ? ex.owner === w.ordinals.address : false;
    if (ex === undefined) checks.push({ id: 'existence', label: 'Name on chain', status: 'pending', detail: 'Checking with Counterparty…' });
    else if (ex === 'error') checks.push({ id: 'existence', label: 'Name on chain', status: 'fail', detail: 'Could not ask the Counterparty node. Retry in a moment.' });
    else if (form.kind === 'reinscription') {
      if (!ex) checks.push({ id: 'existence', label: 'Name on chain', status: 'fail', detail: `${name} does not exist yet: mint it as a counter first.` });
      else if (!mine) checks.push({ id: 'existence', label: 'Name on chain', status: 'fail', detail: `${name} belongs to ${ex.owner}.` });
      else if (ex.descriptionLocked) checks.push({ id: 'existence', label: 'Name on chain', status: 'fail', detail: `${name}'s description is locked: it cannot take a new file.` });
      else checks.push({ id: 'existence', label: 'Name on chain', status: 'ok', detail: `${name} is yours; only its description (the file) changes.` });
    } else if (ex) {
      checks.push({ id: 'existence', label: 'Name on chain', status: 'fail', detail: mine ? `${name} already exists and is yours: choose "reinscription" to put a new file on it.` : `${name} is taken (owner ${ex.owner}).` });
    } else checks.push({ id: 'existence', label: 'Name on chain', status: 'ok', detail: `${name} is free.` });
  } else if (!name && form.kind !== 'reinscription') checks.push({ id: 'existence', label: 'Name on chain', status: 'skip', detail: 'A drawn numeric name is checked at compose time.' });

  // Burn
  if (burn > 0n) {
    const bal = facts.xcpBalance;
    if (bal === null) checks.push({ id: 'burn', label: 'XCP burn', status: 'pending', detail: `${XCP(burn)} will be burned; checking balance…` });
    else if (bal === 'error') checks.push({ id: 'burn', label: 'XCP burn', status: 'fail', detail: 'Could not read your XCP balance.' });
    else if (bal < burn) checks.push({ id: 'burn', label: 'XCP burn', status: 'fail', detail: `A named asset burns ${XCP(burn)}; this address holds ${XCP(bal)}. Leave the name empty for a free numeric one.` });
    else checks.push({ id: 'burn', label: 'XCP burn', status: 'ok', detail: `${XCP(burn)} burned (you hold ${XCP(bal)}).` });
  } else checks.push({ id: 'burn', label: 'XCP burn', status: 'ok', detail: 'None: numeric names, subassets and reinscriptions burn nothing.' });

  // Sale parameters
  if (form.kind === 'fairminter') {
    const problems = form.fairminter ? kit.fairminterProblems(form.fairminter) : ['waiting for the chain tip to schedule the sale'];
    checks.push(problems.length ? { id: 'sale', label: 'Sale parameters', status: form.fairminter ? 'fail' : 'pending', detail: problems[0]! } : { id: 'sale', label: 'Sale parameters', status: 'ok', detail: form.preset === 'xcp69' ? 'XCP-69 template (fixed).' : 'Custom sale is consistent.' });
  }

  // Weight + BTC
  let estimate: ReturnType<CountersKit['estimate']> | null = null;
  if (form.bytes && form.feeRate) {
    estimate = kit.estimate({ bytes: form.bytes.length, feeRate: form.feeRate, kind: form.kind, ...(name && checks[1]!.status === 'ok' ? { assetName: name } : {}), mimeType: form.mimeType || 'application/octet-stream', ...(form.kind === 'counter' ? { quantity: form.quantity } : {}), ...(form.fairminter ? { fairminter: form.fairminter } : {}) });
    const cap = kit.STANDARD_WITNESS_LIMIT_WU;
    if (estimate.standardRelay) checks.push({ id: 'weight', label: 'Reveal weight', status: 'ok', detail: `${estimate.revealWeight.toLocaleString('en-US')} WU ≤ ${cap.toLocaleString('en-US')} WU: relays through the public network.` });
    else if (form.route === 'slipstream') checks.push({ id: 'weight', label: 'Reveal weight', status: 'warn', detail: `${estimate.revealWeight.toLocaleString('en-US')} WU is over the ${cap.toLocaleString('en-US')} WU relay cap; it goes direct to a miner via Slipstream (the commit must confirm first).` });
    else checks.push({ id: 'weight', label: 'Reveal weight', status: 'fail', detail: `${estimate.revealWeight.toLocaleString('en-US')} WU is over the ${cap.toLocaleString('en-US')} WU standard relay cap. No fee rate fixes that: choose the Slipstream route or a smaller file.` });
    const need = estimate.commitValue + Math.ceil(155 * form.feeRate) + estimate.revealOutputs;
    const have = facts.btcAvailable;
    if (have === null) checks.push({ id: 'btc', label: 'BTC at the address', status: 'pending', detail: 'Checking…' });
    else if (have === 'error') checks.push({ id: 'btc', label: 'BTC at the address', status: 'fail', detail: 'Could not read the address balance.' });
    else if (have < need) checks.push({ id: 'btc', label: 'BTC at the address', status: 'fail', detail: `Needs about ${need.toLocaleString('en-US')} sats; ${have.toLocaleString('en-US')} available.` });
    else checks.push({ id: 'btc', label: 'BTC at the address', status: 'ok', detail: `About ${need.toLocaleString('en-US')} sats needed; ${have.toLocaleString('en-US')} available.` });
  } else {
    checks.push({ id: 'weight', label: 'Reveal weight', status: 'pending', detail: form.bytes ? 'Choose a fee rate.' : 'Add a file.' });
  }

  const blocking = checks.find((c) => c.status === 'fail' || c.status === 'pending');
  const ready = !blocking && !!form.bytes && !!form.feeRate && (!!form.mimeType);
  return { checks, estimate, ready, blocker: blocking ? blocking.detail : !form.bytes ? 'Add a file.' : null };
}

export interface MintDeps {
  services: Services;
  store: KeyValueStore | null;
  network: Network;
  onStage: (s: CountersStage) => void;
  onPending: (p: PendingCounters) => void;
}

/** Compose parameters for the mode, in Core's names. */
export function composeParams(kit: CountersKit, form: CountersForm, asset: string, existing: AssetInfo | null): Record<string, string> {
  if (!form.bytes) throw new Error('no file');
  const { description } = kit.encodeContent(form.bytes, form.mimeType);
  const common = { description, mime_type: form.mimeType, encoding: 'taproot', inscription: String(form.ordWrapper), sat_per_vbyte: String(form.feeRate), verbose: 'true', exclude_utxos_with_balances: 'true' };
  if (form.kind === 'fairminter') {
    if (!form.fairminter) throw new Error('A fairminter deploy needs its parameters.');
    const problems = kit.fairminterProblems(form.fairminter);
    if (problems.length) throw new UserFacingError(problems.join('; '), 'Fix the sale parameters; nothing was signed.');
    return { ...kit.fairminterComposeParams(form.fairminter, asset), ...common };
  }
  if (form.kind === 'reinscription') {
    if (!existing) throw new UserFacingError('A reinscription needs an asset that already exists.', 'Pick one of your assets.');
    return { asset, quantity: '0', divisible: String(existing.divisible), lock: 'false', ...common };
  }
  return { asset, quantity: form.quantity.toString(), divisible: String(form.divisible), lock: String(form.lockQuantity), ...common };
}

export async function mintCounter(deps: MintDeps, wallet: WalletSession, form: CountersForm): Promise<CountersResult> {
  const { services, network } = deps;
  const kit = services.counters;
  if (!form.bytes || !form.feeRate) throw new UserFacingError('Add a file and a fee rate first.', 'Nothing was composed.');
  const source = wallet.ordinals.address;
  const plan = planRevealSigning(wallet);

  deps.onStage('checking');
  const asset = form.asset.trim() || kit.randomNumericAsset();
  const existing = form.kind === 'reinscription' ? await services.cp.getAsset(asset) : null;

  deps.onStage('composing');
  const compose = await services.cp.compose(source, form.kind === 'fairminter' ? 'fairminter' : 'issuance', composeParams(kit, form, asset, existing));
  const revealWeight = kit.revealWeightOf(compose);
  if (revealWeight > kit.STANDARD_WITNESS_LIMIT_WU && form.route !== 'slipstream') {
    throw new UserFacingError(`The composed reveal is ${revealWeight.toLocaleString('en-US')} WU, over the ${kit.STANDARD_WITNESS_LIMIT_WU.toLocaleString('en-US')} WU relay cap.`, 'Choose the Slipstream route or a smaller file. Nothing was signed.');
  }
  const topUp = kit.commitTopUp(compose, form.feeRate);
  const commit = kit.buildCommitPsbt({ network, compose, leafKey32: plan.leafPubkey, topUpSats: topUp });
  const expectedCommitTxid = kit.unsignedRevealTxid(commit.psbtBase64);

  deps.onStage('signing-commit');
  // XCP Wallet refuses a commit without the inscription context; Horizon (and the rest) sign a plain PSBT.
  const signedCommit = await wallet.signPsbt(commit.psbtBase64, {
    inputsToSign: commit.inputsToSign.map((index) => ({ index, address: source })),
    inscription: { envelopeScriptHex: commit.leafHex, commitAddress: commit.commitAddress },
    finalize: false,
    broadcast: false,
  });
  const commitFinal = kit.finalize(signedCommit.psbtBase64);
  if (commitFinal.txid !== expectedCommitTxid) throw new TxidMismatchError(expectedCommitTxid, commitFinal.txid);

  const reveal = kit.buildRevealPsbt({ network, compose, leafKey32: plan.leafPubkey, commitOutpoint: { txid: commitFinal.txid, vout: commit.commitVout }, commitValue: commit.commitValue, destinationAddress: source });
  const pending: PendingCounters = {
    kind: 'counters',
    network,
    walletId: wallet.id,
    source,
    asset,
    mintKind: form.kind,
    ...(form.kind === 'fairminter' ? { preset: form.preset, ...(form.fairminter ? { fairminter: form.fairminter } : {}) } : {}),
    revealPsbtBase64: reveal.psbtBase64,
    commitTxid: commitFinal.txid,
    commitValue: commit.commitValue,
    revealWeight,
    leafHex: commit.leafHex,
    commitAddress: commit.commitAddress,
    route: form.route,
    savedAt: Date.now(),
  };
  // On disk BEFORE the commit goes out: a mint that fails after this point is recoverable from any session.
  savePendingCounters(deps.store, pending);
  deps.onPending(pending);

  deps.onStage('broadcasting-commit');
  const commitTxid = await broadcast(services, wallet, commitFinal.hex);
  if (commitTxid !== commitFinal.txid) throw new UserFacingError(`The relay reported ${commitTxid}, not ${commitFinal.txid}.`, 'The pending mint is saved; check the explorer before signing anything else.');

  const revealDone = await finishReveal(deps, wallet, pending);
  return {
    kind: form.kind,
    asset,
    commitTxid,
    revealTxid: revealDone.txid,
    commitValue: commit.commitValue,
    commitFee: commit.fee,
    revealFee: commit.commitValue - (compose.signed_reveal_rawtransaction ? 0 : 0) - revealOutputsOf(form),
    revealWeight: revealDone.weight,
    route: form.route,
    ...(form.kind === 'fairminter' ? { preset: form.preset, ...(form.fairminter ? { fairminter: form.fairminter } : {}) } : {}),
  };
}

const revealOutputsOf = (form: CountersForm) => (form.ordWrapper ? 546 : 0);

async function broadcast(services: Services, wallet: WalletSession, hex: string): Promise<string> {
  if (wallet.capabilities.broadcast && wallet.pushTx) {
    try {
      return await wallet.pushTx(hex);
    } catch {
      /* fall through to the node / Esplora */
    }
  }
  try {
    return await services.cp.broadcast(hex);
  } catch {
    return services.chain.broadcast(hex);
  }
}

/** Sign the (saved) reveal and broadcast it. Separate so it can be retried on its own. */
export async function finishReveal(deps: MintDeps, wallet: WalletSession, pending: PendingCounters): Promise<{ txid: string; weight: number }> {
  const { services } = deps;
  if (wallet.ordinals.address !== pending.source) throw new UserFacingError(`This mint was started from ${pending.source}; the connected wallet is ${wallet.ordinals.address}.`, 'Connect the account that made the commit: only its key can sign the reveal.');
  const plan = planRevealSigning(wallet);
  deps.onStage('signing-reveal');
  const signed = await wallet.signPsbt(pending.revealPsbtBase64, { inputsToSign: [plan.inputToSign], inscription: { envelopeScriptHex: pending.leafHex, commitAddress: pending.commitAddress }, finalize: false, broadcast: false });
  const final = services.counters.finalize(signed.psbtBase64);
  deps.onStage('broadcasting-reveal');
  if (pending.route === 'slipstream') {
    // Hand-off happens outside the page (the commit must be mined first); the txid is exact already.
    clearPendingCounters(deps.store);
    return { txid: final.txid, weight: final.weight };
  }
  if (final.weight > services.counters.STANDARD_WITNESS_LIMIT_WU) throw new UserFacingError(`The signed reveal is ${final.weight.toLocaleString('en-US')} WU, past the relay cap.`, 'It needs the Slipstream route; the pending mint is kept.');
  const txid = await broadcast(services, wallet, final.hex);
  const known = await services.cp.knowsTx(txid).catch(() => true);
  if (!known) throw new UserFacingError('The relay accepted the reveal but the node has never seen it.', 'The commit is untouched: sign the reveal again.');
  clearPendingCounters(deps.store);
  return { txid: txid || final.txid, weight: final.weight };
}
