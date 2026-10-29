/**
 * Tests that cannot pass on GitHub runners, each with an owner and a reason.
 * Nothing is quarantined silently: the lane runner prints every entry, and
 * in CI it skips exactly these tests. `test: "*"` takes the whole file out.
 * Locally the list is printed and nothing is skipped.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type QuarantineEntry = {
  readonly file: string;
  /** The reporter's name without the file: `suite > test`, or `*`. */
  readonly test: string;
  readonly owner: string;
  readonly reason: string;
  readonly date: string;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const QUARANTINE_FILE = "tests/ci-quarantine.json";

const FIELDS = ["file", "test", "owner", "reason", "date"] as const;

export const readQuarantine = (): readonly QuarantineEntry[] => {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, QUARANTINE_FILE), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${QUARANTINE_FILE}: expected an array`);
  return parsed.map((entry: unknown, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    for (const field of FIELDS) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw new Error(`${QUARANTINE_FILE}[${index}]: "${field}" is required`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(record.date as string)) {
      throw new Error(`${QUARANTINE_FILE}[${index}]: "date" is YYYY-MM-DD`);
    }
    return record as QuarantineEntry;
  });
};

export const formatQuarantine = (entries: readonly QuarantineEntry[]): string =>
  entries.length === 0
    ? `ci-quarantine: none (${QUARANTINE_FILE})`
    : [
        `ci-quarantine: ${entries.length} skipped in CI (${QUARANTINE_FILE})`,
        ...entries.map(
          (entry) =>
            `  ${entry.file} > ${entry.test}\n    owner ${entry.owner}, since ${entry.date}: ${entry.reason}`,
        ),
      ].join("\n");
