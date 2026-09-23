import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const OPENAPI_PATH = 'contracts/openapi/ledger.yaml';
export const ASYNCAPI_PATH = 'contracts/asyncapi/ledger.yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openapi: any = parse(readFileSync(`${repoRoot}${OPENAPI_PATH}`, 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const asyncapi: any = parse(readFileSync(`${repoRoot}${ASYNCAPI_PATH}`, 'utf8'));

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(openapi, 'contract');

/** Assert `value` validates against `#/components/schemas/<name>`; throws with ajv's message otherwise. */
export function assertSchema(name: string, value: unknown): void {
  const v = ajv.getSchema(`contract#/components/schemas/${name}`);
  if (!v) throw new Error(`no schema ${name} in ${OPENAPI_PATH}`);
  if (!v(value)) throw new Error(`${name} contract violation: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value, null, 2)}`);
}

/** Validate a response body against the schema the contract declares for (path, method, status). */
export async function expectContract(res: Response, path: string, method: string, expectedStatus: number): Promise<unknown> {
  if (res.status !== expectedStatus) throw new Error(`${method.toUpperCase()} ${path}: expected ${expectedStatus}, got ${res.status}: ${await res.text()}`);
  const op = openapi.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`${method} ${path} not in contract`);
  let response = op.responses[String(res.status)];
  if (!response) throw new Error(`${method} ${path} ${res.status} not in contract`);
  if (response.$ref) response = deref(response.$ref);
  const content = response.content?.['application/json'];
  if (!content) return undefined;
  const body = await res.json();
  const schema = content.schema;
  const name = schema?.$ref ? String(schema.$ref).replace('#/components/schemas/', '') : undefined;
  if (name) assertSchema(name, body);
  else {
    // inline schema: validate by JSON pointer so `$ref`s inside it resolve against the contract document
    const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
    const pointer = `contract#/paths/${esc(path)}/${method.toLowerCase()}/responses/${res.status}/content/${esc('application/json')}/schema`;
    const v = ajv.getSchema(pointer) ?? ajv.compile({ $ref: pointer });
    if (!v(body)) throw new Error(`${method} ${path} ${res.status} contract violation: ${ajv.errorsText(v.errors)}`);
  }
  return body;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deref = (ref: string): any =>
  ref
    .replace(/^#\//, '')
    .split('/')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .reduce((node: any, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], openapi);
