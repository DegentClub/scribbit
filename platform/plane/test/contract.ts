import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const OPENAPI_PATH = 'contracts/openapi/plane.yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openapi: any = parse(readFileSync(`${repoRoot}${OPENAPI_PATH}`, 'utf8'));

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(openapi, 'contract');

export function assertSchema(name: string, value: unknown): void {
  const v = ajv.getSchema(`contract#/components/schemas/${name}`);
  if (!v) throw new Error(`no schema ${name} in ${OPENAPI_PATH}`);
  if (!v(value)) throw new Error(`${name} contract violation: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value, null, 2)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deref = (ref: string): any => ref.replace(/^#\//, '').split('/').reduce((node: any, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], openapi);

/** Validate a response against what the contract declares for (path, method, status); returns the parsed body. */
export async function expectContract<T = unknown>(res: Response, path: string, method: string, expectedStatus: number): Promise<T> {
  if (res.status !== expectedStatus) throw new Error(`${method.toUpperCase()} ${path}: expected ${expectedStatus}, got ${res.status}: ${await res.text()}`);
  const op = openapi.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`${method} ${path} not in contract`);
  let response = op.responses[String(res.status)];
  if (!response) throw new Error(`${method} ${path} ${res.status} not in contract`);
  if (response.$ref) response = deref(response.$ref);
  const schema = response.content?.['application/json']?.schema;
  const body = (await res.json()) as T;
  if (!schema) throw new Error(`${method} ${path} ${res.status} declares no JSON body`);
  const name = String(schema.$ref ?? '').replace('#/components/schemas/', '');
  assertSchema(name, body);
  return body;
}
