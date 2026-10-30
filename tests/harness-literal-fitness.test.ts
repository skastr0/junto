/**
 * A new harness is its record plus its decoders, and nothing else: outside
 * them, no code in shared or main compares a harness id to a literal. Where a
 * harness differs, its record says how, and the code reads the record.
 *
 * The renderer is product's and is not held here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";

const root = process.cwd();

/** The records, and the decoders that read one harness's own output or files. */
const RECORDS_AND_DECODERS = [
  /^src\/shared\/harness-records\.ts$/,
  /^src\/shared\/harness-capabilities\.ts$/,
  /^src\/shared\/managed-terminal-templates\.ts$/,
  /^src\/shared\/harness-domain\//,
  /^src\/main\/junto\/term\/harness-record\.ts$/,
  /^src\/main\/junto\/term\/agent-state\/rules\//,
  // Hook payloads, one shape per harness; hooks are outside the PTY effort.
  /^src\/main\/junto\/term\/agent-state\/hook-feed\.ts$/,
];

/**
 * Known comparisons still to move, each with why it is not moved yet. The
 * list only shrinks.
 */
const KNOWN: readonly { readonly file: string; readonly text: string; readonly why: string }[] = [
  {
    file: "src/main/junto/term/agent-state/engine.ts",
    text: 'pack.harness !== "codex"',
    why: "the hook ladder, outside the PTY effort",
  },
  {
    file: "src/main/junto/term/drive/claude-resume-recovery.ts",
    text: 'deps.harnessOf(event.bindingId) !== "claude"',
    why: "Claude's attention recovery; the same comparison, now in the core's resume drive",
  },
];

const ids = HARNESS_IDS.map((id) => id.replace(/[-]/g, "\\-")).join("|");
const COMPARISON = new RegExp(
  [
    // harness === "amp", seat.harness !== "amp", harnessOf(seat) === "amp", h === "amp"
    `(?:\\b\\w*[hH]arness\\w*\\b(?:\\([^()]*\\))?|\\bh\\b)\\s*[!=]==\\s*"(?:${ids})"`,
    // "amp" === harness
    `"(?:${ids})"\\s*[!=]==\\s*[\\w.]*[hH]arness`,
  ].join("|"),
);

const sourcesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) ? [relative(root, path)] : [];
  });

describe("harness literals", () => {
  it("are compared only inside the records and their decoders", () => {
    const found: string[] = [];
    for (const file of [...sourcesUnder(join(root, "src", "shared")), ...sourcesUnder(join(root, "src", "main"))]) {
      if (RECORDS_AND_DECODERS.some((pattern) => pattern.test(file))) continue;
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!COMPARISON.test(line)) return;
          if (KNOWN.some((known) => known.file === file && line.includes(known.text))) return;
          found.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("keeps every known exception real, so the list only shrinks", () => {
    for (const known of KNOWN) {
      expect(readFileSync(join(root, known.file), "utf8"), known.file).toContain(known.text);
    }
  });

  it("catches the shapes it is meant to", () => {
    for (const line of [
      'if (harness === "amp") {',
      'seat.harness !== "prime-agent"',
      'harnessOf(seat) !== "amp"',
      'sources.harnessFor(event.bindingId) === "claude"',
      'if (h === "codex")',
      '"junto-overseer" === input.harness',
    ]) {
      expect(COMPARISON.test(line), line).toBe(true);
    }
    for (const line of ['bundle.source === "hermes"', 'statement.role === "cursor"', 'capability === "hermes"']) {
      expect(COMPARISON.test(line), line).toBe(false);
    }
  });
});
