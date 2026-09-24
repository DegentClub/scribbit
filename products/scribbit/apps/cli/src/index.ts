/** Programmatic entry: run the scribbit CLI in-process (tests, other tools). */
export { MAIN_HELP, run, VERSION } from './cli.js';
export { CliError, EXIT, parseArgs } from './args.js';
export type { CliIO } from './io.js';
export { nodeIO } from './io.js';
export { walkScript } from './commands/envelope.js';
export { ANCHOR_CONTENT_TYPE, anchorContent, parseCheckpointHead } from './commands/anchor.js';
