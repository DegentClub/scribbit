#!/usr/bin/env node
// The @bsh/mesh command line. Runs the TypeScript sources directly under Node 22's
// native type stripping (no build, no tsx) - which is why src/ imports carry `.ts`.
//
//   node platform/mesh/bin/mesh.mjs help
import { runCli } from '../src/cli.ts';

const code = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exitCode = code;
