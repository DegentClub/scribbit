// The `mesh` command line, as an in-process runner so tests drive it without spawning.
//
//   mesh check-charter <file>
//   mesh check-frontdoor <file>
//   mesh check-directory <file> [--externals <file>]
//   mesh emit-charter <charter> <out...>
//   mesh emit-frontdoor <config> <out>
//   mesh emit-directory <charter> <out> [--config <file>]
//   mesh checkpoint <fragments...> --origin <id-or-url> --out <file> [--sign <key.pem>] [--at <iso>]
//   mesh keygen --out <dir> [--bip340]
//   mesh emit <dir> [--frozen] [--rev <rev>]
//                          regenerate every published file under <dir>/public from <dir>/*.json;
//                          with shiplog.config.json present, append the records from git (--frozen: from the committed fragment only)
//   mesh check <dir>       validate them, and fail if any is stale against its source
//
// Exit 0 ok · 1 findings (errors) · 2 fatal (usage, missing file, bad JSON). `--json` for machines.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nobleBip340 } from './binding.ts';
import { canonicalStringify, bytesToHex } from './canonical.ts';
import { assertCharter, type Charter, charterSummary, validateCharter } from './charter.ts';
import { checkpointHead, claimsOf, signCheckpointHead } from './checkpoint.ts';
import { type Finding, finding, hasErrors, isRecord } from './common.ts';
import { type DirectoryOptions, directoryFromCharter, directorySummary, SURFACE_PATHS, validateDirectory } from './directory.ts';
import { emitFrontdoor, type FrontdoorConfig, frontdoorSummary, validateFrontdoor } from './frontdoor.ts';
import { generateKeyPair } from './keys.ts';
import { CHECKPOINT_KEY_ENV, deriveRecords, gitLog, projectShiplog, readRecordsConfig, RECORD_PATHS, type RecordFiles, recordsHead, recordsSummary, repoRootOf, validateRecords } from './records.ts';
import { type DevlogFragment, devlogFragment, type ShippedFragment, validateDevlog, validateShipped } from './shipped.ts';

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_FATAL = 2;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Paths resolve against this; default process.cwd(). */
  cwd?: string;
  /** Environment (MESH_CHECKPOINT_KEY); default process.env. */
  env?: Record<string, string | undefined>;
}

export interface CliResult {
  command: string;
  ok: boolean;
  exit: number;
  summary: string;
  findings: Finding[];
  /** Command-specific extras (paths written, kid, head...). */
  [extra: string]: unknown;
}

class Fatal extends Error {}

const VALUE_FLAGS = new Set(['externals', 'config', 'origin', 'out', 'sign', 'at', 'rev']);

export function parseArgv(argv: readonly string[]): { command: string; positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined) throw new Fatal(`--${name} needs a value`);
        flags[name] = v;
      } else flags[name] = true;
    } else positionals.push(a);
  }
  const [command = 'help', ...rest] = positionals;
  return { command, positionals: rest, flags };
}

const USAGE = `mesh — FlashyOS AAO formats and money documents (@bsh/mesh)

  mesh check-charter <file>
  mesh check-frontdoor <file>
  mesh check-directory <file> [--externals <file>]
  mesh emit-charter <charter> <out...>
  mesh emit-frontdoor <config> <out>
  mesh emit-directory <charter> <out> [--config <file>]
  mesh checkpoint <fragments...> --origin <id-or-url> --out <file> [--sign <key.pem>] [--at <iso>]
  mesh keygen --out <dir> [--bip340]
  mesh emit <dir>       regenerate <dir>/public/** from <dir>/charter.json, frontdoor.config.json, directory.config.json;
                        with <dir>/shiplog.config.json: append shipped/1 + devlog/1 from git log --first-parent and
                        write the checkpoint/1 head (signed too when $MESH_CHECKPOINT_KEY names a key)
    --frozen            do not read git: rebuild the served projections from the committed shiplog.fragment.json (CI)
    --rev <rev>         the revision git walks (default HEAD, or "rev" in the config)
  mesh check <dir>      validate them and fail on anything stale (records: every seal, the projection, the head)

  --json    machine-readable output
  exit 0 ok · 1 findings · 2 fatal
`;

const PUBLISHED = {
  charter: 'charter.json',
  frontdoorConfig: 'frontdoor.config.json',
  directoryConfig: 'directory.config.json',
  charterWellKnown: 'public/.well-known/flashyos-charter.json',
  charterRoles: 'public/flashyos.roles.json',
  frontdoor: 'public/.well-known/frontdoor.json',
  directory: 'public/directory.fragment.json',
  externals: 'directory.externals.json',
} as const;

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new Fatal(`no file at ${file}`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Fatal(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Fatal(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, pretty(value));
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);

/** The DirectoryOptions a `directory.config.json` describes, with surfaces detected on disk under `root`. */
export function directoryOptionsFrom(config: unknown, root: string): DirectoryOptions {
  if (!isRecord(config)) throw new Fatal('directory config is a JSON object');
  const c = config;
  if (typeof c.asserted !== 'string') throw new Fatal('directory config needs "asserted" (YYYY-MM-DD) — a dated fragment is a reproducible one');
  if (typeof c.assertedBy !== 'string') throw new Fatal('directory config needs "assertedBy" (person/<slug>)');
  const expires = typeof c.expires === 'string' ? c.expires : new Date(Date.parse(`${c.asserted}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10);
  const servedRoot = typeof c.servedRoot === 'string' ? path.resolve(root, c.servedRoot) : root;
  const served = SURFACE_PATHS.flatMap(([, , candidates]) => candidates.filter((p) => existsSync(path.join(servedRoot, p))));
  const opts: DirectoryOptions = { asserted: c.asserted, expires, assertedBy: c.assertedBy, served };
  if (typeof c.source === 'string') opts.source = c.source;
  if (typeof c.platform === 'string') opts.platform = c.platform;
  if (typeof c.vertical === 'string') opts.vertical = c.vertical;
  if (Array.isArray(c.properties)) opts.properties = c.properties as DirectoryOptions['properties'];
  if (Array.isArray(c.emitters)) opts.emitters = c.emitters as DirectoryOptions['emitters'];
  if (c.surfaceHost === null || typeof c.surfaceHost === 'string') opts.surfaceHost = c.surfaceHost;
  if (c.visibility === 'public' || c.visibility === 'partner' || c.visibility === 'private') opts.visibility = c.visibility;
  return opts;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const at = (p: string): string => path.resolve(cwd, p);
  const rel = (p: string): string => path.relative(cwd, p) || '.';
  let json = false;
  let command = 'help';
  const done = (result: CliResult): number => {
    if (json) io.stdout(`${JSON.stringify(result)}\n`);
    else {
      for (const f of result.findings) io.stderr(`  ${f.severity === 'warning' ? '!' : '✗'} ${f.code}  ${f.path}\n      ${f.message}\n`);
      io.stdout(`\n  ${result.summary}\n\n`);
    }
    return result.exit;
  };
  const result = (findings: Finding[], summary: string, extra: Record<string, unknown> = {}): CliResult => {
    const exit = hasErrors(findings) ? EXIT_FINDINGS : EXIT_OK;
    return { command, ok: exit === EXIT_OK, exit, summary, findings, ...extra };
  };

  try {
    const parsed = parseArgv(argv);
    command = parsed.command;
    const { positionals, flags } = parsed;
    json = flags.json === true;
    const need = (i: number, what: string): string => {
      const v = positionals[i];
      if (v === undefined) throw new Fatal(`usage: mesh ${command} — missing ${what}\n\n${USAGE}`);
      return v;
    };
    const flag = (name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);

    switch (command) {
      case 'help':
      case '--help': {
        io.stdout(USAGE);
        return EXIT_OK;
      }

      case 'check-charter': {
        const file = at(need(0, '<file>'));
        const doc = readJson(file);
        const findings = validateCharter(doc);
        return done(result(findings, charterSummary(doc, findings), { file: rel(file) }));
      }

      case 'check-frontdoor': {
        const file = at(need(0, '<file>'));
        const doc = readJson(file);
        const findings = validateFrontdoor(doc);
        return done(result(findings, frontdoorSummary(doc, findings), { file: rel(file) }));
      }

      case 'check-directory': {
        const file = at(need(0, '<file>'));
        const doc = readJson(file);
        const explicit = flag('externals');
        const extFile = explicit ? at(explicit) : path.join(path.dirname(file), PUBLISHED.externals);
        // A named externals file must exist; the implicit one beside the fragment may be absent (a fragment that borrows nothing needs no file).
        const externals = explicit || existsSync(extFile) ? readExternals(extFile) : [];
        const findings = validateDirectory(doc, externals);
        return done(result(findings, directorySummary(doc, findings), { file: rel(file), externals: externals.length ? rel(extFile) : null }));
      }

      case 'emit-charter': {
        const file = at(need(0, '<charter>'));
        need(1, '<out>');
        const doc = readJson(file);
        const findings = validateCharter(doc);
        const outs = positionals.slice(1).map(at);
        if (!hasErrors(findings)) for (const o of outs) writeJson(o, doc);
        return done(result(findings, `${charterSummary(doc, findings)}${hasErrors(findings) ? ' — nothing written' : ` → ${outs.map(rel).join(', ')}`}`, { written: hasErrors(findings) ? [] : outs.map(rel) }));
      }

      case 'emit-frontdoor': {
        const cfgFile = at(need(0, '<config>'));
        const out = at(need(1, '<out>'));
        const cfg = readJson(cfgFile);
        if (!isRecord(cfg)) throw new Fatal(`${rel(cfgFile)} is not a frontdoor config object`);
        const door = emitFrontdoor(cfg as unknown as FrontdoorConfig);
        const findings = validateFrontdoor(door);
        if (!hasErrors(findings)) writeJson(out, door);
        return done(result(findings, `${frontdoorSummary(door, findings)}${hasErrors(findings) ? ' — nothing written' : ` → ${rel(out)}`}`, { written: hasErrors(findings) ? [] : [rel(out)] }));
      }

      case 'emit-directory': {
        const charterFile = at(need(0, '<charter>'));
        const out = at(need(1, '<out>'));
        const cfgFile = flag('config') ? at(flag('config')!) : undefined;
        const charterDoc = readJson(charterFile);
        const charterFindings = validateCharter(charterDoc);
        if (hasErrors(charterFindings)) return done(result(charterFindings, `${charterSummary(charterDoc, charterFindings)} — the charter must conform before a fragment is derived from it`));
        const root = path.dirname(cfgFile ?? charterFile);
        const cfg = cfgFile ? readJson(cfgFile) : {};
        const opts = directoryOptionsFrom(cfg, root);
        const { fragment, externals } = directoryFromCharter(charterDoc as Charter, opts);
        const findings = validateDirectory(fragment, externals.ids);
        const extOut = isRecord(cfg) && typeof cfg.externalsOut === 'string' ? path.resolve(root, cfg.externalsOut) : path.join(root, PUBLISHED.externals);
        if (!hasErrors(findings)) {
          writeJson(out, fragment);
          writeJson(extOut, externals);
        }
        return done(result(findings, `${directorySummary(fragment, findings)}${hasErrors(findings) ? ' — nothing written' : ` → ${rel(out)}, ${rel(extOut)}`}`, { written: hasErrors(findings) ? [] : [rel(out), rel(extOut)] }));
      }

      case 'checkpoint': {
        const origin = flag('origin');
        const out = flag('out');
        if (!origin || !out) throw new Fatal(`usage: mesh checkpoint <fragments...> --origin <id-or-url> --out <file>`);
        const files = positionals.map(at);
        if (!files.length) throw new Fatal('checkpoint needs at least one fragment');
        const missing = files.filter((f) => !existsSync(f));
        const fragments = files.filter((f) => existsSync(f)).map(readJson);
        const claims = claimsOf(fragments);
        let head: Record<string, unknown> = checkpointHead(claims, origin, flag('at')) as unknown as Record<string, unknown>;
        if (flag('sign')) {
          const pem = readFileSync(at(flag('sign')!), 'utf8');
          head = signCheckpointHead(head as unknown as Parameters<typeof signCheckpointHead>[0], pem) as unknown as Record<string, unknown>;
        }
        writeJson(at(out), head);
        const counts = Object.entries((head.counts as Record<string, number> | undefined) ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ');
        const summary = `${String(head.size)} claims → ${rel(at(out))} · root ${String(head.root)}${counts ? ` · ${counts}` : ''}${missing.length ? ` · not found, so not committed to: ${missing.map(rel).join(', ')}` : ''}`;
        return done(result([], summary, { head, missing: missing.map(rel), written: [rel(at(out))] }));
      }

      case 'keygen': {
        const dir = flag('out');
        if (!dir) throw new Fatal('usage: mesh keygen --out <dir> [--bip340]');
        const outDir = at(dir);
        mkdirSync(outDir, { recursive: true });
        const privPath = path.join(outDir, 'ed25519.key.pem');
        const pubPath = path.join(outDir, 'ed25519.pub.pem');
        if (existsSync(privPath)) throw new Fatal(`${rel(privPath)} already exists — refusing to overwrite a private key`);
        const pair = generateKeyPair();
        writeFileSync(privPath, pair.privateKey, { mode: 0o600 });
        writeFileSync(pubPath, pair.publicKey);
        const written = [rel(privPath), rel(pubPath)];
        const extra: Record<string, unknown> = { kid: pair.kid, publicKey: pair.publicKey };
        if (flags.bip340 === true) {
          const secPath = path.join(outDir, 'bip340.secret.hex');
          const xonlyPath = path.join(outDir, 'bip340.xonly.hex');
          if (existsSync(secPath)) throw new Fatal(`${rel(secPath)} already exists — refusing to overwrite a secret key`);
          const secret = nobleBip340.randomSecretKey();
          const xonly = bytesToHex(nobleBip340.getPublicKey(secret));
          writeFileSync(secPath, `${bytesToHex(secret)}\n`, { mode: 0o600 });
          writeFileSync(xonlyPath, `${xonly}\n`);
          written.push(rel(secPath), rel(xonlyPath));
          extra.xonlyPubkeyHex = xonly;
        }
        writeJson(path.join(outDir, 'public.json'), { kid: pair.kid, publicKey: pair.publicKey, ...(extra.xonlyPubkeyHex ? { xonlyPubkeyHex: extra.xonlyPubkeyHex } : {}) });
        written.push(rel(path.join(outDir, 'public.json')));
        return done(result([], `kid ${pair.kid} → ${rel(outDir)} (private material is mode 0600; never commit it)`, { ...extra, written }));
      }

      case 'emit': {
        const dir = at(need(0, '<dir>'));
        const findings: Finding[] = [];
        const written: string[] = [];
        const charterDoc = readJson(path.join(dir, PUBLISHED.charter));
        findings.push(...validateCharter(charterDoc));
        if (hasErrors(findings)) return done(result(findings, `${charterSummary(charterDoc, findings)} — nothing written`));
        const charter = assertCharter(charterDoc);
        for (const p of [PUBLISHED.charterWellKnown, PUBLISHED.charterRoles]) {
          writeJson(path.join(dir, p), charter);
          written.push(rel(path.join(dir, p)));
        }
        const fdCfgFile = path.join(dir, PUBLISHED.frontdoorConfig);
        if (existsSync(fdCfgFile)) {
          const cfg = readJson(fdCfgFile) as FrontdoorConfig;
          const door = emitFrontdoor(cfg);
          const fdFindings = validateFrontdoor(door);
          findings.push(...fdFindings);
          if (!hasErrors(fdFindings)) {
            const out = path.join(dir, typeof cfg.out === 'string' ? cfg.out : PUBLISHED.frontdoor);
            writeJson(out, door);
            written.push(rel(out));
          }
        }
        // Records: the sealed log is APPENDED to (committed entries are history and kept byte for
        // byte), the served files are projections of it. They are written before the directory so
        // the fragment can declare the surfaces this run creates.
        const recCfgFile = path.join(dir, RECORD_PATHS.config);
        const records = existsSync(recCfgFile) ? readRecordsConfig(readJson(recCfgFile)) : undefined;
        const extra: Record<string, unknown> = {};
        let shiplog: ShippedFragment | undefined;
        const servedByRecords: string[] = [];
        if (records) {
          const fragFile = path.join(dir, RECORD_PATHS.fragment);
          const devlogFile = path.join(dir, RECORD_PATHS.devlog);
          const existingFragment = existsSync(fragFile) ? readJson(fragFile) : undefined;
          if (existingFragment !== undefined && !(isRecord(existingFragment) && Array.isArray(existingFragment.entries))) throw new Fatal(`${rel(fragFile)} is not a shipped/1 fragment`);
          const existingDevlog = existsSync(devlogFile) ? readJson(devlogFile) : undefined;
          if (existingDevlog !== undefined && !(isRecord(existingDevlog) && Array.isArray(existingDevlog.entries))) throw new Fatal(`${rel(devlogFile)} is not a devlog/1 fragment`);
          let fragment: ShippedFragment;
          let devlog: DevlogFragment;
          const rFindings: Finding[] = [];
          if (flags.frozen === true) {
            if (existingFragment === undefined) throw new Fatal(`--frozen rebuilds the served files from ${rel(fragFile)}, and there is none yet - run \`mesh emit ${rel(dir)}\` without --frozen first`);
            fragment = existingFragment as unknown as ShippedFragment;
            devlog = (existingDevlog as unknown as DevlogFragment | undefined) ?? devlogFragment(records, [], fragment.generated);
            shiplog = projectShiplog(records, fragment);
            extra.appended = [];
          } else {
            const repoRoot = repoRootOf(dir);
            const derived = deriveRecords(gitLog(repoRoot, flag('rev') ?? records.rev), records, {
              fragment: existingFragment as unknown as ShippedFragment | undefined,
              devlog: existingDevlog as unknown as DevlogFragment | undefined,
            });
            ({ fragment, devlog, shiplog } = derived);
            extra.appended = derived.appended;
            extra.repoRoot = rel(repoRoot);
            for (const email of derived.unmapped) rFindings.push(finding('unmapped-author', RECORD_PATHS.config, `${email} is not in "authors" - attributed to ${records.defaultAuthor} (a person) or agent/unattributed (a machine)`, 'warning'));
            for (const [sha, kind] of derived.badKinds) rFindings.push(finding('bad-recorded-kind', `${RECORD_PATHS.config}#kinds.${sha}`, `"${kind}" is not a shipped/1 kind`));
          }
          rFindings.push(...validateShipped(fragment), ...validateShipped(shiplog), ...validateDevlog(devlog));
          findings.push(...rFindings);
          if (hasErrors(rFindings)) shiplog = undefined;
          else {
            writeJson(fragFile, fragment);
            writeJson(path.join(dir, RECORD_PATHS.shiplog), shiplog);
            writeJson(devlogFile, devlog);
            written.push(rel(fragFile), rel(path.join(dir, RECORD_PATHS.shiplog)), rel(devlogFile));
            servedByRecords.push(RECORD_PATHS.shiplog, RECORD_PATHS.checkpoint);
            extra.sealed = fragment.entries.length;
          }
        }
        const dirCfgFile = path.join(dir, PUBLISHED.directoryConfig);
        let directoryDoc: unknown;
        if (existsSync(dirCfgFile)) {
          const cfg = readJson(dirCfgFile);
          const opts = directoryOptionsFrom(cfg, dir);
          opts.served = [...new Set([...(opts.served ?? []), ...servedByRecords])];
          const { fragment, externals } = directoryFromCharter(charter, opts);
          const dFindings = validateDirectory(fragment, externals.ids);
          findings.push(...dFindings);
          if (!hasErrors(dFindings)) {
            const extOut = isRecord(cfg) && typeof cfg.externalsOut === 'string' ? path.resolve(dir, cfg.externalsOut) : path.join(dir, PUBLISHED.externals);
            writeJson(path.join(dir, PUBLISHED.directory), fragment);
            writeJson(extOut, externals);
            written.push(rel(path.join(dir, PUBLISHED.directory)), rel(extOut));
            directoryDoc = fragment;
          }
        }
        if (records && shiplog) {
          // The head commits to what is SERVED (the public log and the fragment), so a reader with
          // only the URLs can recompute it. FlashyOS's head is unsigned; ours is too, and the signed
          // copy beside it is written only when the operator points at a key.
          const head = recordsHead(shiplog, directoryDoc, records.origin ?? records.source);
          writeJson(path.join(dir, RECORD_PATHS.checkpoint), head);
          written.push(rel(path.join(dir, RECORD_PATHS.checkpoint)));
          extra.head = head;
          const keyPath = (io.env ?? process.env)[CHECKPOINT_KEY_ENV];
          if (keyPath) {
            if (!existsSync(at(keyPath))) throw new Fatal(`${CHECKPOINT_KEY_ENV}=${keyPath}: no such file`);
            const signed = signCheckpointHead(head, readFileSync(at(keyPath), 'utf8'));
            writeJson(path.join(dir, RECORD_PATHS.checkpointSigned), signed);
            written.push(rel(path.join(dir, RECORD_PATHS.checkpointSigned)));
            extra.kid = signed['x-signature'].kid;
          }
          extra.records = recordsSummary(shiplog, head);
        }
        const account = typeof extra.records === 'string' ? ` · records: ${extra.records}${Array.isArray(extra.appended) ? `, ${extra.appended.length} appended` : ''}` : '';
        return done(result(findings, `${charter.name} — ${written.length} file(s) written · ${findings.length} problem(s)${account}`, { written, ...extra }));
      }

      case 'check': {
        const dir = at(need(0, '<dir>'));
        const findings: Finding[] = [];
        const checked: string[] = [];
        const charterDoc = readJson(path.join(dir, PUBLISHED.charter));
        findings.push(...validateCharter(charterDoc));
        checked.push(rel(path.join(dir, PUBLISHED.charter)));
        for (const p of [PUBLISHED.charterWellKnown, PUBLISHED.charterRoles]) {
          const served = path.join(dir, p);
          if (!existsSync(served)) findings.push(finding('charter-not-served', p, 'the charter is not in the served directory — run `mesh emit`'));
          else if (!sameJson(readJson(served), charterDoc)) findings.push(finding('charter-served-stale', p, 'the served charter differs from charter.json — run `mesh emit`'));
          checked.push(rel(served));
        }
        const fdCfgFile = path.join(dir, PUBLISHED.frontdoorConfig);
        if (existsSync(fdCfgFile)) {
          const cfg = readJson(fdCfgFile) as FrontdoorConfig;
          const expected = emitFrontdoor(cfg);
          const doorFile = path.join(dir, typeof cfg.out === 'string' ? cfg.out : PUBLISHED.frontdoor);
          checked.push(rel(doorFile));
          if (!existsSync(doorFile)) findings.push(finding('frontdoor-not-served', rel(doorFile), 'the door is not written — run `mesh emit`'));
          else {
            const door = readJson(doorFile);
            findings.push(...validateFrontdoor(door));
            if (!sameJson(door, expected)) findings.push(finding('frontdoor-stale', rel(doorFile), 'the written door differs from frontdoor.config.json — run `mesh emit`'));
          }
        }
        const dirCfgFile = path.join(dir, PUBLISHED.directoryConfig);
        if (existsSync(dirCfgFile) && !hasErrors(validateCharter(charterDoc))) {
          const cfg = readJson(dirCfgFile);
          const expected = directoryFromCharter(charterDoc as Charter, directoryOptionsFrom(cfg, dir));
          const fragFile = path.join(dir, PUBLISHED.directory);
          const extFile = isRecord(cfg) && typeof cfg.externalsOut === 'string' ? path.resolve(dir, cfg.externalsOut) : path.join(dir, PUBLISHED.externals);
          checked.push(rel(fragFile), rel(extFile));
          const externals = existsSync(extFile) ? readExternals(extFile) : null;
          if (externals === null) findings.push(finding('externals-missing', rel(extFile), 'no directory.externals.json — run `mesh emit`'));
          else if (!sameJson(externals, expected.externals.ids)) findings.push(finding('externals-stale', rel(extFile), 'directory.externals.json differs from what the emitter derives — run `mesh emit`'));
          if (!existsSync(fragFile)) findings.push(finding('directory-not-served', rel(fragFile), 'the fragment is not written — run `mesh emit`'));
          else {
            const fragment = readJson(fragFile);
            findings.push(...validateDirectory(fragment, externals ?? expected.externals.ids));
            if (!sameJson(fragment, expected.fragment)) findings.push(finding('directory-stale', rel(fragFile), 'the written fragment differs from the charter and directory.config.json — run `mesh emit`'));
          }
        }
        // Records: every seal recomputed, the served log proved to be the fragment's public
        // projection, the head recomputed from the served files, the signed copy (if any) verified.
        // git is not consulted: the committed log may lag HEAD (a commit cannot carry its own entry).
        const recCfgFile = path.join(dir, RECORD_PATHS.config);
        let records: string | undefined;
        if (existsSync(recCfgFile)) {
          const config = readRecordsConfig(readJson(recCfgFile));
          checked.push(rel(recCfgFile));
          const optional = (p: string, count = true): unknown => {
            const file = path.join(dir, p);
            const present = existsSync(file);
            if (present || count) checked.push(rel(file));
            return present ? readJson(file) : undefined;
          };
          const files: RecordFiles = {
            config,
            fragment: optional(RECORD_PATHS.fragment),
            shiplog: optional(RECORD_PATHS.shiplog),
            devlog: optional(RECORD_PATHS.devlog),
            checkpoint: optional(RECORD_PATHS.checkpoint),
            checkpointSigned: optional(RECORD_PATHS.checkpointSigned, false),
          };
          const dirFrag = path.join(dir, PUBLISHED.directory);
          if (existsSync(dirFrag)) files.directory = readJson(dirFrag);
          findings.push(...validateRecords(files));
          const head = isRecord(files.checkpoint) && typeof files.checkpoint.root === 'string' ? (files.checkpoint as unknown as Parameters<typeof recordsSummary>[1]) : undefined;
          records = recordsSummary(isRecord(files.fragment) && Array.isArray(files.fragment.entries) ? (files.fragment as unknown as ShippedFragment) : undefined, head);
        }
        const name = isRecord(charterDoc) && typeof charterDoc.name === 'string' ? charterDoc.name : rel(dir);
        return done(result(findings, `${name} — ${checked.length} file(s) checked · ${findings.length} problem(s)${records ? ` · records: ${records}` : ''}`, { checked, ...(records ? { records } : {}) }));
      }

      default:
        throw new Fatal(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) io.stdout(`${JSON.stringify({ command, ok: false, exit: EXIT_FATAL, error: message })}\n`);
    else io.stderr(`error: ${message}\n`);
    return EXIT_FATAL;
  }
}

function readExternals(file: string): string[] {
  const doc = readJson(file);
  if (!isRecord(doc) || !Array.isArray(doc.ids) || !doc.ids.every((i) => typeof i === 'string')) throw new Fatal(`${file} is not an externals file ({ ids: string[] })`);
  return doc.ids as string[];
}
