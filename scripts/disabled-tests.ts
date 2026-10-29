/**
 * Tests taken out of the unit lanes and CI, each with an owner and a reason:
 * wall-time bounds and heavy replays or sweeps that fail only under load
 * (operator ruling, 2026-10-29). Nothing is disabled silently: every lane
 * run, local or CI, prints the list and skips exactly these tests.
 * `test: "*"` takes the whole file out. A targeted `vitest run <file>` still
 * runs them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DisabledEntry = {
  readonly file: string;
  /** The reporter's name without the file: `suite > test`, or `*`. */
  readonly test: string;
  readonly owner: string;
  readonly reason: string;
  readonly date: string;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DISABLED_FILE = "tests/disabled-tests.json";

const FIELDS = ["file", "test", "owner", "reason", "date"] as const;

export const readDisabled = (): readonly DisabledEntry[] => {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, DISABLED_FILE), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${DISABLED_FILE}: expected an array`);
  return parsed.map((entry: unknown, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    for (const field of FIELDS) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw new Error(`${DISABLED_FILE}[${index}]: "${field}" is required`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(record.date as string)) {
      throw new Error(`${DISABLED_FILE}[${index}]: "date" is YYYY-MM-DD`);
    }
    return record as DisabledEntry;
  });
};

export const formatDisabled = (entries: readonly DisabledEntry[]): string =>
  entries.length === 0
    ? `disabled-tests: none (${DISABLED_FILE})`
    : [
        `disabled-tests: ${entries.length} skipped in every lane run (${DISABLED_FILE})`,
        ...entries.map(
          (entry) =>
            `  ${entry.file} > ${entry.test}\n    owner ${entry.owner}, since ${entry.date}: ${entry.reason}`,
        ),
      ].join("\n");
