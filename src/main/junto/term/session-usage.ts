/**
 * Readers for the token counts harnesses record in their own transcripts.
 * Each returns one record's context size (input, cache and output of that
 * model call), or undefined when the record carries none.
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (value: unknown, ...path: string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** One transcript record's context size, or undefined when it records none. */
export type UsageReader = (record: Json) => number | undefined;

const positive = (total: number): number | undefined => (total > 0 ? total : undefined);

export const claudeUsage: UsageReader = (record) => {
  // A sub-agent's turn is its own context, not the seat's.
  if (record.type !== "assistant" || record.isSidechain === true) return undefined;
  const usage = at(record, "message", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(
    count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.output_tokens),
  );
};

/** Codex counts cached input inside input, so the last call's total is the context. */
export const codexUsage: UsageReader = (record) =>
  positive(count(at(record, "payload", "info", "last_token_usage", "total_tokens")));

/** Pi, Prime Agent and Oh My Pi share one message shape. */
export const piUsage: UsageReader = (record) =>
  positive(count(at(record, "message", "usage", "totalTokens")));

export const kimiUsage: UsageReader = (record) => {
  const usage = at(record, "event", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(
    count(usage.inputOther) +
      count(usage.inputCacheRead) +
      count(usage.inputCacheCreation) +
      count(usage.output),
  );
};

/** Muse is a Codex fork: cached input is counted inside input. */
export const museUsage: UsageReader = (record) => {
  const usage = at(record, "payload", "event", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(count(usage.input_tokens) + count(usage.output_tokens));
};

export const grokUsage: UsageReader = (record) =>
  positive(count(at(record, "params", "_meta", "totalTokens")));

/** The last usage record in the tail of a JSONL transcript; `cut` drops a partial first row. */
export const lastJsonlUsage = (tail: string, cut: boolean, reader: UsageReader): number | undefined => {
  const rows = tail.split("\n");
  for (let index = rows.length - 1; index >= (cut ? 1 : 0); index -= 1) {
    const row = rows[index]!.trim();
    if (row.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(row);
      const tokens = isRecord(parsed) ? reader(parsed) : undefined;
      if (tokens !== undefined) return tokens;
    } catch {
      // Not a record: keep looking.
    }
  }
  return undefined;
};

/**
 * Amp keeps a thread as one JSON document, so there are no lines to walk. The
 * last usage in the tail is found by its own field names.
 */
export const ampDocumentUsage = (tail: string): number | undefined => {
  const inputs = [...tail.matchAll(/"totalInputTokens"\s*:\s*(\d+)/g)];
  const last = inputs[inputs.length - 1];
  if (last === undefined || last.index === undefined) return undefined;
  // The output count is another field of the same flat usage object: the
  // text between the brace that opens it and the brace that closes it.
  const open = tail.lastIndexOf("{", last.index);
  const close = tail.indexOf("}", last.index);
  const usage = tail.slice(Math.max(0, open), close < 0 ? tail.length : close);
  const output = usage.match(/"outputTokens"\s*:\s*(\d+)/);
  return positive(Number(last[1]) + (output ? Number(output[1]) : 0));
};
