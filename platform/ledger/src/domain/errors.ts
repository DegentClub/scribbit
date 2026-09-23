import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Domain error carrying the HTTP status and stable code the API maps it to (via `EdgeError`). */
export class LedgerError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const notFound = (what: string, id: string): LedgerError => new LedgerError(404, 'not_found', `${what} ${id} not found`);
export const invalid = (message: string): LedgerError => new LedgerError(400, 'invalid_request', message);

/** Thrown by stores when an optimistic-concurrency check fails; callers re-read and retry. */
export class ConcurrencyError extends LedgerError {
  constructor(what: string, id: string) {
    super(409, 'concurrent_update', `${what} ${id} was modified concurrently`);
    this.name = 'ConcurrencyError';
  }
}
