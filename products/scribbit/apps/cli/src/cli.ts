import { CliError, EXIT } from './args.js';
import { ANCHOR_HELP, ANCHOR_VERIFY_HELP, anchorCommand, anchorVerifyCommand } from './commands/anchor.js';
import { commitAddressCommand, COMMIT_HELP } from './commands/commit-address.js';
import { envelopeCommand, ENVELOPE_HELP } from './commands/envelope.js';
import { quoteCommand, QUOTE_HELP } from './commands/quote.js';
import { rescueCommand, RESCUE_HELP } from './commands/rescue.js';
import type { CommandResult } from './commands/types.js';
import type { CliIO } from './io.js';

export const VERSION = '0.1.0';

type Handler = (argv: string[], io: CliIO) => Promise<CommandResult>;

const COMMANDS: Record<string, { run: Handler; help: string; summary: string }> = {
  quote: { run: quoteCommand, help: QUOTE_HELP, summary: 'Exact reveal weight/vsize, lane, fees and commit value' },
  envelope: { run: envelopeCommand, help: ENVELOPE_HELP, summary: 'Hex dump summary of the inscription tapscript' },
  'commit-address': { run: commitAddressCommand, help: COMMIT_HELP, summary: 'P2TR commit address for a file and reveal key' },
  rescue: { run: rescueCommand, help: RESCUE_HELP, summary: 'Build the self-rescue transaction from a half-signed reveal' },
  anchor: { run: anchorCommand, help: ANCHOR_HELP, summary: 'Quote a mesh checkpoint/1 head as an inscription (anchor on Bitcoin)' },
  'anchor-verify': { run: anchorVerifyCommand, help: ANCHOR_VERIFY_HELP, summary: 'Prove a claim id against an anchored checkpoint root' },
};

export const MAIN_HELP = `scribbit ${VERSION}: put anything on Bitcoin (developer CLI over @bsh/inscription)

Usage: scribbit <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(15)} ${c.summary}`)
  .join('\n')}
  help <command>  Show help for a command

Global options:
  --json          Print exactly one JSON object on stdout ({"ok":true,...} or {"ok":false,"error":{...}})
  -h, --help      Show help
  --version       Print the version

Exit codes:
  0  success
  1  failure (fee source unreachable, internal error)
  2  usage error (unknown command or option, malformed value)
  3  input rejected (unreadable file, too large for any lane, invalid PSBT)

Examples:
  scribbit quote art.webp --parent <txid>i0 --fee-rate 2.5
  scribbit quote big.png --network signet --fee-source https://mempool.space/signet
  scribbit envelope note.txt --json
  scribbit commit-address art.webp --pubkey <xonly> --network mainnet
  scribbit rescue --psbt @reveal.psbt
  scribbit anchor flashy/public/.well-known/checkpoint.json --network mainnet --fee-rate 2 --pubkey <xonly>
  scribbit anchor-verify checkpoint.json --claim ship/scribbit/<sha12> --claims shiplog.json directory.fragment.json
`;

/** Run the CLI in-process. Returns the exit code; never calls process.exit. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const json = argv.includes('--json');
  const [first, ...rest] = argv;
  const command = first && !first.startsWith('-') ? first : undefined;
  try {
    if (!command) {
      if (argv.includes('--version')) return print(io, json, { version: VERSION }, VERSION);
      if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || (json && argv.length === 1)) {
        io.stdout(MAIN_HELP);
        return argv.length === 0 ? EXIT.USAGE : EXIT.OK;
      }
      throw new CliError(`unknown option ${first}; see scribbit --help`, EXIT.USAGE, 'usage');
    }
    if (command === 'help') {
      const target = rest.find((a) => !a.startsWith('-'));
      if (!target) return (io.stdout(MAIN_HELP), EXIT.OK);
      const c = COMMANDS[target];
      if (!c) throw new CliError(`unknown command "${target}"; see scribbit --help`, EXIT.USAGE, 'usage');
      return (io.stdout(c.help), EXIT.OK);
    }
    const c = COMMANDS[command];
    if (!c) throw new CliError(`unknown command "${command}"; see scribbit --help`, EXIT.USAGE, 'usage');
    const result = await c.run(rest, io);
    if ('help' in result) return (io.stdout(result.help), EXIT.OK);
    return print(io, json, { command, ...result.data }, result.human);
  } catch (e) {
    const err =
      e instanceof CliError ? e : new CliError(`internal error: ${e instanceof Error ? e.message : String(e)}`, EXIT.FAILURE, 'internal');
    if (json) {
      const error: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      io.stdout(`${JSON.stringify({ ok: false, command: command ?? null, exitCode: err.exitCode, error })}\n`);
    } else {
      io.stderr(`scribbit: ${err.message}\n`);
      if (err.exitCode === EXIT.USAGE && command && COMMANDS[command]) io.stderr(`run "scribbit ${command} --help" for usage\n`);
    }
    return err.exitCode;
  }
}

function print(io: CliIO, json: boolean, data: Record<string, unknown>, human: string): number {
  io.stdout(json ? `${JSON.stringify({ ok: true, ...data })}\n` : `${human}\n`);
  return EXIT.OK;
}
