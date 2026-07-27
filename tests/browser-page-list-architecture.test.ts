import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "src");

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });

const retiredIdentifiers = [
  ["max", "Directory", "Entries"].join(""),
  ["max", "Scan", "Bytes"].join(""),
  ["BROWSER_MAX_CANVAS", "_DIRECTORY_ENTRIES"].join(""),
  ["BROWSER_MAX_CANVAS", "_SCAN_BYTES"].join(""),
] as const;

describe("browser page-list architecture", () => {
  it.each(retiredIdentifiers)(
    "keeps retired filesystem query vocabulary absent: %s",
    (retiredIdentifier) => {
      const occurrences = sourceFiles(root).filter((path) =>
        readFileSync(path, "utf8").includes(retiredIdentifier),
      );

      expect(occurrences).toEqual([]);
    },
  );
});
