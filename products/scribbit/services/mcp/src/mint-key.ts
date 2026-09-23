/**
 * `pnpm --filter @bsh/scribbit-mcp mint-key -- [--env live|test] [--id <id>] [--owner <ownerId>] [--scopes mcp]`
 * Prints the key ONCE (stderr, for the human) and the record to configure (stdout, hash only).
 */
import { generateApiKey, type ApiKeyRecord } from '@bsh/edge';

export function mintKey(argv: readonly string[]): { key: string; hint: string; record: ApiKeyRecord } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    flags.set(a.slice(2), v);
    i++;
  }
  const env = flags.get('env') ?? 'live';
  if (env !== 'live' && env !== 'test') throw new Error('--env must be live or test');
  const id = flags.get('id') ?? `key_${Date.now().toString(36)}`;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) throw new Error('--id must be a short identifier');
  const scopes = (flags.get('scopes') ?? 'mcp').split(',').map((s) => s.trim()).filter(Boolean);
  const k = generateApiKey(env);
  const record: ApiKeyRecord = { id, hash: k.hash, env, scopes };
  const owner = flags.get('owner');
  if (owner) record.ownerId = owner;
  return { key: k.key, hint: k.hint, record };
}

if (process.argv[1] && /mint-key\.[cm]?[jt]s$/.test(process.argv[1])) {
  try {
    const { key, hint, record } = mintKey(process.argv.slice(2));
    console.error(`API key (shown once, never stored): ${key}`);
    console.error(`hint: ${hint}`);
    console.log(JSON.stringify(record, null, 2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
