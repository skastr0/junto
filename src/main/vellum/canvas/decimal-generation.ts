/**
 * Canonical arbitrary-precision decimal generation ordering.
 *
 * SQLite INTEGER casts truncate above signed 64-bit range. Plain text order
 * also puts "10" before "9". Validate the durable decimal first, then compare
 * by digit count and code units. No conversion to a fixed-width number occurs.
 */
export class DecimalGenerationError extends Error {
  constructor(readonly value: unknown, readonly label: string) {
    super(`${label} is not a canonical unsigned decimal generation: ${String(value)}`);
    this.name = "DecimalGenerationError";
  }
}

declare const decimalGenerationBrand: unique symbol;
export type DecimalGeneration = string & {
  readonly [decimalGenerationBrand]: true;
};

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export const parseDecimalGeneration = (
  value: unknown,
  label = "generation",
): DecimalGeneration => {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    throw new DecimalGenerationError(value, label);
  }
  return value as DecimalGeneration;
};

export const compareDecimalGenerations = (
  left: string,
  right: string,
): -1 | 0 | 1 => {
  const a = parseDecimalGeneration(left, "left generation");
  const b = parseDecimalGeneration(right, "right generation");
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

export const orderDecimalGenerations = (
  values: ReadonlyArray<string>,
): ReadonlyArray<DecimalGeneration> =>
  values
    .map((value, index) =>
      parseDecimalGeneration(value, `generation at index ${index}`),
    )
    .sort(compareDecimalGenerations);
