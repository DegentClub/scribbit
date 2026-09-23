import { buildRescueReveal, inscriptionIdFromReveal } from '@bsh/inscription';
import { helpFor, parseArgs, rejected, usage, type FlagSpec } from '../args.js';
import { fmt, GLOBAL_FLAGS, NETWORK_FLAG, parseNetwork, readInput, table } from '../common.js';
import type { CliIO } from '../io.js';
import type { CommandResult } from './types.js';

export const RESCUE_FLAGS: Record<string, FlagSpec> = {
  psbt: { type: 'string', arg: '<b64>', description: 'Half-signed reveal PSBT: base64, @file, or - for stdin' },
  network: { ...NETWORK_FLAG, description: 'mainnet | testnet | signet | regtest (default mainnet)' },
  ...GLOBAL_FLAGS,
};

export const RESCUE_HELP = helpFor(
  'rescue',
  'finalize a half-signed reveal into the self-rescue transaction (no parent)',
  'scribbit rescue --psbt <b64 | @file | -> [--network <net>] [--json]',
  RESCUE_FLAGS,
  'Legacy mode: a half-signed PSBT whose commit input was signed SIGHASH_SINGLE|ANYONECANPAY (0x83) IS the rescue\n' +
    'transaction. Reveals built with the current default (SIGHASH_ALL|ANYONECANPAY, 0x81) are rescued by re-signing\n' +
    'with your ephemeral key from the recovery bundle (`buildResignedRescue` in @bsh/inscription); a `rescue --key`\n' +
    'mode for that is tracked in the CLI README.\n' +
    'transaction. Broadcast the printed hex with any node or `bitcoin-cli sendrawtransaction`. The inscription\n' +
    'lands without on-chain parent provenance. Nothing is broadcast by this command.',
);

export async function rescueCommand(argv: string[], io: CliIO): Promise<CommandResult> {
  const args = parseArgs(argv, RESCUE_FLAGS);
  if (args.flags.help) return { help: RESCUE_HELP };
  if (args.positionals.length) throw usage(`unexpected argument "${args.positionals[0]}" (pass the PSBT with --psbt)`);
  const network = parseNetwork(args.flags.network, 'mainnet');
  const raw = args.flags.psbt as string | undefined;
  if (raw === undefined) throw usage('--psbt <b64> is required (base64, @file or - for stdin)');
  let psbt: string;
  if (raw === '-') psbt = await io.readStdin();
  else if (raw.startsWith('@')) psbt = new TextDecoder().decode(await readInput(io, raw.slice(1), 'PSBT file'));
  else psbt = raw;
  psbt = psbt.replace(/\s+/g, '');
  if (!psbt) throw usage('--psbt is empty');

  let r: ReturnType<typeof buildRescueReveal>;
  try {
    r = buildRescueReveal({ network, halfSignedPsbtBase64: psbt });
  } catch (e) {
    throw rejected('invalid_psbt', `not a valid half-signed reveal PSBT: ${(e as Error).message}`);
  }
  const data = { network, txid: r.txid, inscriptionId: inscriptionIdFromReveal(r.txid), weight: r.weight, vsize: r.vsize, hex: r.hex };
  const human = [
    table([
      ['txid', r.txid],
      ['inscription', data.inscriptionId],
      ['size', `${fmt(r.weight)} WU / ${fmt(r.vsize)} vB`],
    ]),
    '',
    r.hex,
  ].join('\n');
  return { data, human };
}
