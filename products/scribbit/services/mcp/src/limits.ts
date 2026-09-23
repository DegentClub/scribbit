import { LIMITS } from '@bsh/inscription';

/** Largest decoded `contentBase64` a tool accepts (4 MiB). Anything above the block lane is refused by the maths anyway. */
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** Largest decoded `metadataBase64` (CBOR, tag 5). */
export const MAX_METADATA_BYTES = 1024 * 1024;
/** Longest base64 string that can decode to MAX_CONTENT_BYTES (with padding). Checked BEFORE decoding. */
export const MAX_CONTENT_BASE64_CHARS = Math.ceil(MAX_CONTENT_BYTES / 3) * 4;
export const MAX_METADATA_BASE64_CHARS = Math.ceil(MAX_METADATA_BYTES / 3) * 4;
/** A half-signed reveal PSBT carrying a 4 MiB body is < 6 MiB in base64. */
export const MAX_PSBT_BASE64_CHARS = 6 * 1024 * 1024;
/** Default JSON-RPC body limit for POST /mcp: one 4 MiB body in base64 plus JSON overhead. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_CONTENT_TYPE_BYTES = LIMITS.MAX_SCRIPT_ELEMENT_SIZE;
