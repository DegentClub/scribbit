import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Stable, machine-readable tool error codes. Agents branch on these; messages are for humans. */
export type ToolErrorCode =
  | 'invalid_input'
  | 'content_too_large'
  | 'content_hash_mismatch'
  | 'too_large'
  | 'invalid_psbt'
  | 'fees_unavailable'
  | 'fee_rate_required'
  | 'unsupported_network'
  | 'forbidden_scope'
  | 'ledger_unavailable'
  | 'ledger_rejected'
  | 'order_not_found'
  | 'internal';

export interface ToolErrorBody {
  error: { code: ToolErrorCode; message: string; details?: unknown };
}

/** Thrown by tool implementations; turned into an `isError` result (never a transport-level failure). */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
  }

  toBody(): ToolErrorBody {
    return { error: this.details === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, details: this.details } };
  }
}

export const invalid = (message: string, details?: unknown) => new ToolError('invalid_input', message, details);

/** JSON-serialisable success result: the same object as text (for models) and as structuredContent (for programs). */
export function okResult<T extends Record<string, unknown>>(data: T, summary?: string): CallToolResult {
  const text = summary ? `${summary}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export function errorResult(e: ToolError): CallToolResult {
  const body = e.toBody();
  return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}` }], structuredContent: body as unknown as Record<string, unknown> };
}

/**
 * Run a tool body; every failure becomes a structured error result. Unknown exceptions are reported as
 * `internal` with a generic message: stack traces and library messages never reach the caller.
 */
export async function guarded(fn: () => Promise<CallToolResult> | CallToolResult, onUnexpected?: (e: unknown) => void): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) return errorResult(e);
    onUnexpected?.(e);
    return errorResult(new ToolError('internal', 'tool failed unexpectedly'));
  }
}
