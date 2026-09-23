/**
 * Ordinal sat assignment (ord's FIFO rule), simulated over a proposed transaction.
 *
 * Rule: concatenate the sats of every input, in input order, into one stream. Outputs take
 * contiguous chunks from that stream in output order; whatever is left at the tail is the fee
 * (it goes to the miner via the coinbase). An inscription sits on one sat, so its destination is
 * simply the position of that sat in the stream: `sum(value of inputs before it) + offset`.
 *
 * Consequences this module lets callers check before signing (see the README, "Sat assignment"):
 * - each output gets exactly one contiguous slice, so two inscriptions separated by padding can
 *   never share an output in a single transaction (shave first, then pack);
 * - a funding input placed *ahead* of an inscription input shifts every inscription behind it, and
 *   whatever slides past `sum(outputs)` is burned to the fee;
 * - the safety invariant `sum(outputs) >= total value of the inscription inputs`, with inscription
 *   inputs strictly ahead of funding inputs, guarantees no burn.
 *
 * Pure, no I/O, `bigint` throughout (values and offsets may be given as `number` for
 * convenience and are converted exactly; non-integers and negatives throw).
 */

/** A run of sats. `[start, end)` when the sat numbers are known; `{ unknown: n }` for n sats whose
 *  numbering was never told to us (e.g. an externally supplied funding UTXO). Unknown runs still
 *  occupy stream positions, so placement stays exact even when the sat numbers are not. */
export type SatRange = { start: bigint; end: bigint } | { unknown: bigint };

export interface InscriptionRef {
  id: string;
  /** Offset of the inscribed sat inside its input (0 = first sat). */
  offset: bigint | number;
}

export interface SatInput {
  value: bigint | number;
  /** Optional sat ranges of this input, in order; must sum to `value` when given. */
  sats?: SatRange[];
  inscriptions?: InscriptionRef[];
}

export interface SatOutput {
  value: bigint | number;
}

export interface PlacedInscription {
  id: string;
  /** Offset of the inscribed sat inside the output it landed in (or inside the fee tail). */
  offset: bigint;
  /** Sat number when the source input's ranges were known, else null. */
  sat: bigint | null;
  /** Where it came from. */
  input: number;
  inputOffset: bigint;
}

export interface SatSlice {
  value: bigint;
  ranges: SatRange[];
  inscriptions: PlacedInscription[];
}

export type Destination = { vout: number; offset: bigint } | 'fee';

export interface Placement extends PlacedInscription {
  destination: Destination;
  /** Absolute position in the concatenated input stream. */
  streamPosition: bigint;
}

export interface SatAssignment {
  outputs: SatSlice[];
  fee: SatSlice;
  /** Every inscription, in input order, with where it went. */
  placements: Placement[];
}

const toBig = (v: bigint | number, name: string): bigint => {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new RangeError(`${name} must be non-negative, got ${v}`);
    return v;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new RangeError(`${name} must be a non-negative safe integer or bigint, got ${String(v)}`);
  return BigInt(v);
};

const rangeLen = (r: SatRange, name: string): bigint => {
  if ('unknown' in r) return toBig(r.unknown, `${name}.unknown`);
  const start = toBig(r.start, `${name}.start`);
  const end = toBig(r.end, `${name}.end`);
  if (end < start) throw new RangeError(`${name}: end ${end} precedes start ${start}`);
  return end - start;
};

/** Internal stream chunk: [streamStart, satStart | null, length]. */
interface Chunk {
  pos: bigint;
  sat: bigint | null;
  len: bigint;
}

function chunkOf(chunks: Chunk[], p: bigint): Chunk | undefined {
  // last chunk whose pos <= p (binary search)
  let lo = 0;
  let hi = chunks.length - 1;
  let found: Chunk | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid]!;
    if (c.pos <= p) {
      found = c;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Slice the stream chunks that overlap [a, b) into sat ranges. */
function rangesBetween(chunks: Chunk[], a: bigint, b: bigint): SatRange[] {
  const out: SatRange[] = [];
  if (a >= b) return out;
  // first chunk that ends after a
  let k = 0;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid]!;
    if (c.pos + c.len <= a) lo = mid + 1;
    else {
      k = mid;
      hi = mid - 1;
    }
  }
  for (; k < chunks.length && chunks[k]!.pos < b; k++) {
    const c = chunks[k]!;
    const from = a > c.pos ? a : c.pos;
    const to = b < c.pos + c.len ? b : c.pos + c.len;
    if (from >= to) continue;
    out.push(c.sat === null ? { unknown: to - from } : { start: c.sat + (from - c.pos), end: c.sat + (to - c.pos) });
  }
  return out;
}

/**
 * Apply ord's FIFO rule to `inputs` → `outputs`. Throws when outputs exceed inputs, an inscription
 * offset lies outside its input, or given sat ranges do not sum to the input value.
 */
export function assignSats(inputs: readonly SatInput[], outputs: readonly SatOutput[]): SatAssignment {
  const chunks: Chunk[] = [];
  const inputStarts: bigint[] = [];
  let pos = 0n;
  inputs.forEach((input, i) => {
    const value = toBig(input.value, `inputs[${i}].value`);
    inputStarts.push(pos);
    if (input.sats && input.sats.length > 0) {
      let sum = 0n;
      input.sats.forEach((r, j) => {
        const n = rangeLen(r, `inputs[${i}].sats[${j}]`);
        if (n === 0n) return;
        chunks.push({ pos: pos + sum, sat: 'unknown' in r ? null : BigInt(r.start), len: n });
        sum += n;
      });
      if (sum !== value) throw new RangeError(`inputs[${i}].sats sum to ${sum}, value is ${value}`);
    } else if (value > 0n) {
      chunks.push({ pos, sat: null, len: value });
    }
    pos += value;
  });
  const totalIn = pos;

  const bounds: Array<{ start: bigint; end: bigint }> = [];
  let c = 0n;
  outputs.forEach((o, j) => {
    const v = toBig(o.value, `outputs[${j}].value`);
    bounds.push({ start: c, end: c + v });
    c += v;
  });
  const totalOut = c;
  if (totalOut > totalIn) throw new RangeError(`outputs (${totalOut}) exceed inputs (${totalIn})`);

  const locate = (p: bigint): Destination => {
    if (p >= totalOut) return 'fee';
    // first output whose end > p (skips zero-value outputs, which take no sats)
    let lo = 0;
    let hi = bounds.length - 1;
    let j = bounds.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid]!.end > p) {
        j = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return { vout: j, offset: p - bounds[j]!.start };
  };

  const placements: Placement[] = [];
  inputs.forEach((input, i) => {
    const value = toBig(input.value, `inputs[${i}].value`);
    for (const ins of input.inscriptions ?? []) {
      if (typeof ins.id !== 'string' || ins.id.length === 0) throw new TypeError(`inputs[${i}]: inscription id required`);
      const offset = toBig(ins.offset, `inputs[${i}] inscription ${ins.id} offset`);
      if (offset >= value) throw new RangeError(`inputs[${i}]: inscription ${ins.id} offset ${offset} >= value ${value}`);
      const p = inputStarts[i]! + offset;
      const chunk = chunkOf(chunks, p);
      const sat = chunk && chunk.sat !== null ? chunk.sat + (p - chunk.pos) : null;
      const destination = locate(p);
      placements.push({
        id: ins.id,
        offset: destination === 'fee' ? p - totalOut : destination.offset,
        sat,
        input: i,
        inputOffset: offset,
        destination,
        streamPosition: p,
      });
    }
  });

  const strip = ({ id, offset, sat, input, inputOffset }: Placement): PlacedInscription => ({ id, offset, sat, input, inputOffset });
  const outs: SatSlice[] = bounds.map((b, j) => ({
    value: b.end - b.start,
    ranges: rangesBetween(chunks, b.start, b.end),
    inscriptions: placements.filter((p) => p.destination !== 'fee' && p.destination.vout === j).map(strip),
  }));
  const fee: SatSlice = {
    value: totalIn - totalOut,
    ranges: rangesBetween(chunks, totalOut, totalIn),
    inscriptions: placements.filter((p) => p.destination === 'fee').map(strip),
  };
  return { outputs: outs, fee, placements };
}

/**
 * Where does the inscription at `offset` of input `inscriptionInputIndex` land? Only the input
 * values ahead of it and the output values matter. `'fee'` means burned to the miner.
 */
export function inscriptionDestination(
  tx: { inputs: readonly SatOutput[]; outputs: readonly SatOutput[] },
  inscriptionInputIndex: number,
  offset: bigint | number = 0n,
): Destination {
  if (!Number.isInteger(inscriptionInputIndex) || inscriptionInputIndex < 0 || inscriptionInputIndex >= tx.inputs.length)
    throw new RangeError(`inscriptionInputIndex ${inscriptionInputIndex} out of range (${tx.inputs.length} inputs)`);
  const inputs: SatInput[] = tx.inputs.map((i, k) =>
    k === inscriptionInputIndex ? { value: i.value, inscriptions: [{ id: 'x', offset }] } : { value: i.value },
  );
  return assignSats(inputs, tx.outputs).placements[0]!.destination;
}

export class InscriptionBurnError extends Error {
  constructor(readonly burned: readonly Placement[]) {
    super(
      `${burned.length} inscription(s) would be burned to fee: ${burned
        .map((p) => `${p.id} (input ${p.input} offset ${p.inputOffset} → fee offset ${p.offset})`)
        .join(', ')}`,
    );
    this.name = 'InscriptionBurnError';
  }
}

/** Run `assignSats` and throw `InscriptionBurnError` if any inscription would land in the fee. */
export function assertNoInscriptionBurn(inputs: readonly SatInput[], outputs: readonly SatOutput[]): SatAssignment {
  const result = assignSats(inputs, outputs);
  if (result.fee.inscriptions.length > 0) throw new InscriptionBurnError(result.placements.filter((p) => p.destination === 'fee'));
  return result;
}

/**
 * The safety invariant that makes a burn impossible regardless of output layout:
 * every inscription-carrying input is strictly ahead of every input without inscriptions (funding),
 * and `sum(outputs) >= total value of the inscription-carrying inputs`. Returns the reason when it
 * does not hold. Stronger than "funding input last": it also covers sending all funding to fee.
 */
export function checkInscriptionCoverage(
  inputs: readonly SatInput[],
  outputs: readonly SatOutput[],
): { ok: true } | { ok: false; reason: string } {
  let inscribedValue = 0n;
  let seenFunding = false;
  for (const [i, input] of inputs.entries()) {
    const value = toBig(input.value, `inputs[${i}].value`);
    const carries = (input.inscriptions?.length ?? 0) > 0;
    if (carries) {
      if (seenFunding) return { ok: false, reason: `inscription input ${i} sits behind a funding input` };
      inscribedValue += value;
    } else seenFunding = true;
  }
  const totalOut = outputs.reduce((s, o, j) => s + toBig(o.value, `outputs[${j}].value`), 0n);
  if (totalOut < inscribedValue)
    return { ok: false, reason: `outputs (${totalOut}) do not cover the inscription inputs (${inscribedValue})` };
  return { ok: true };
}
