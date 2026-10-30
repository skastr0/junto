/**
 * The prompt box read with its faint cells blanked is the same as a cell by
 * cell walk would spell it, on every snapshot of every committed harness
 * capture and on hand-made rows: faint text, typed spaces, wide characters.
 * A row with no faint cell is its painted text, trimmed.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SessionObserver } from "../src/main/junto/term/observer";
import { withoutFaint } from "../src/main/junto/term/observer/session-observer";
import { promptBoxRows } from "../src/main/junto/term/observer/regions";
import { chunkEvents, corpusRoot, loadP1Fixture } from "./pty-e2e/runner";

type Cell = { getChars: () => string; getWidth: () => number; isDim: () => number };
type Line = { translateToString: (trim?: boolean, start?: number, end?: number) => string; getCell: (x: number, cell?: Cell) => Cell | undefined };
type Grid = { cols: number; rows: number; buffer: { active: { viewportY: number; length: number; getLine: (y: number) => Line | undefined } }; write: (data: string, done: () => void) => void };

/** Every cell spelled out, faint ones as a space: what the box read was before. */
const walked = (line: Line, cols: number): string => {
  let out = "";
  for (let x = 0; x < cols; x++) {
    const at = line.getCell(x);
    if (!at) break;
    if (at.getWidth() === 0) continue;
    out += at.isDim() ? " " : at.getChars() || " ";
  }
  return out.trimEnd();
};

const gridOf = (observer: SessionObserver): Grid => (observer as unknown as { term: Grid }).term;

const expectedBox = (grid: Grid): string[] => {
  const buf = grid.buffer.active;
  const ys = Array.from({ length: grid.rows }, (_, i) => buf.viewportY + i);
  const lines = ys.map((y) => buf.getLine(y)?.translateToString(true, 0, grid.cols) ?? "");
  const [from, to] = promptBoxRows(lines);
  return ys.slice(from, to).map((y) => {
    const line = buf.getLine(y);
    return line === undefined ? "" : walked(line, grid.cols);
  });
};

const captures = (): Array<{ harness: string; scenario: string }> =>
  readdirSync(corpusRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) =>
      readdirSync(`${corpusRoot()}/${dir.name}`)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => ({ harness: dir.name, scenario: file.slice(0, -".jsonl".length) })));

describe("the prompt box without its faint cells", () => {
  it("matches a cell by cell walk on every snapshot of every capture", async () => {
    let compared = 0;
    let faintRows = 0;
    for (const { harness, scenario } of captures()) {
      const fixture = loadP1Fixture(harness, scenario);
      if (fixture === null) continue;
      const observer = new SessionObserver({ bindingId: `${harness}-${scenario}`, epoch: "e1", cols: 120, rows: 32 });
      try {
        observer.subscribe((snap) => {
          const expected = expectedBox(gridOf(observer));
          expect(snap.promptBoxWithoutFaint, `${harness}/${scenario} seq ${snap.seq}`).toEqual(expected);
          compared += 1;
          faintRows += expected.filter((row, i) => row !== snap.lines[promptBoxRows(snap.lines)[0] + i]?.trimEnd()).length;
        });
        for (const chunk of chunkEvents(fixture.events, "whole")) observer.feed(chunk.data, chunk.seq);
        await observer.snapshot();
      } finally {
        observer.dispose();
      }
    }
    expect(compared).toBeGreaterThan(100);
    // The captures hold faint prompt text (claude/prompt-suggestion), so the spelled path is proved too.
    expect(faintRows).toBeGreaterThan(0);
  });

  it("blanks faint text, keeps wide characters, and trims typed trailing spaces", async () => {
    const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: new (options: object) => Grid };
    const grid = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    await new Promise<void>((resolve) => grid.write("> \x1b[2mTry this\x1b[22m   \r\n> 漢字 ok   \r\n\x1b[2m\x1b[22m> plain\r\n", resolve));
    const rows = [0, 1, 2].map((y) => grid.buffer.active.getLine(y)!);
    const read = rows.map((line) => withoutFaint(line, 40, line.translateToString(true, 0, 40)));
    expect(read).toEqual(rows.map((line) => walked(line, 40)));
    expect(read).toEqual([">", "> 漢字 ok", "> plain"]);
  });
});
