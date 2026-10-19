/**
 * Seat session data lives in junto.db alone: a session's notes, the note for
 * its next session, who ended it, whether it onboarded, the continuation
 * ledger and the offboard clock. Nothing under `~/.junto/seats` is written or
 * read any more, and no source names that directory or its files, except
 * state migration 21 -> 22, which imports them once in the step that retires
 * them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The step that retires the files reads them once; nothing else may. */
const IMPORTER = join("main", "junto", "state", "migrate-seat-session-data.ts");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mts|cts)$/.test(name) ? [path] : [];
  });

/** Code only: a comment may still say where the data used to live. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** What the files under `~/.junto/seats` were called, and how code reached them. */
const SEAT_FILES: ReadonlyArray<readonly [string, RegExp]> = [
  ["the seats root", /\bdefaultSeatsRoot\b/],
  ["a path into ~/.junto/seats", /["'`]\.junto["'`]\s*,\s*["'`]seats["'`]|\.junto\/seats\b/],
  ["the notes file helpers", /seat-sessions\/notes-file\b|\bnotesPathFor\b|\bnotesPath\b/],
  ["a notes or continuation file", /\.next\.md\b|\bcontinuationPathOf\b/],
  ["the ended marker", /\.ended\.json\b|\bwriteEndedMarker\b|\breadEndedMarker\b/],
  ["the onboarded marker", /\bonboardedMarkerPath\b|\bmarkSessionOnboarded\b/],
  ["the continuation ledger file", /continuation\.pending\b/],
  ["the offboard clock file", /offboard-clock\.json\b|\boffboardClockPath\b/],
];

describe("no seat session data outside junto.db", () => {
  it("no source writes, reads or names a file under ~/.junto/seats", () => {
    const found = sources(SRC).filter((path) => relative(SRC, path) !== IMPORTER).flatMap((path) => {
      const text = withoutComments(readFileSync(path, "utf8"));
      return SEAT_FILES.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${relative(SRC, path)}: ${what}`);
    });
    expect(found).toEqual([]);
  });
});
