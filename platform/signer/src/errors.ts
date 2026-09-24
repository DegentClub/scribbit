export type SignerErrorCode =
  | 'invalid_request'
  | 'unknown_key'
  | 'psbt_invalid'
  | 'input_mismatch'
  | 'already_signed'
  | 'policy_denied'
  | 'key_provider_error'
  | 'signature_invalid';

const STATUS: Record<SignerErrorCode, number> = {
  invalid_request: 400,
  psbt_invalid: 400,
  unknown_key: 404,
  input_mismatch: 422,
  already_signed: 409,
  policy_denied: 403,
  key_provider_error: 500,
  signature_invalid: 500,
};

/** Every failure the signer reports. `status` is the HTTP status the service maps it to. */
export class SignerError extends Error {
  readonly status: number;
  constructor(
    readonly code: SignerErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'SignerError';
    this.status = STATUS[code];
  }
}

export const isSignerError = (e: unknown): e is SignerError => e instanceof SignerError;
