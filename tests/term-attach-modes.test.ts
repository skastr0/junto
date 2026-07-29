import { describe, expect, it } from "vitest";
import {
  applyDecPrivateMode,
  buildAttachCursorEscape,
  buildAttachRestoreEscapes,
  idleAttachModes,
} from "../src/shared/term-attach-modes";

describe("term-attach-modes", () => {
  it("tracks mouse and alt-screen DEC private modes", () => {
    let m = idleAttachModes();
    m = applyDecPrivateMode(m, 1049, true);
    m = applyDecPrivateMode(m, 1000, true);
    m = applyDecPrivateMode(m, 1006, true);
    m = applyDecPrivateMode(m, 1003, true);
    expect(m.altScreen).toBe(true);
    expect(m.mouseModes).toEqual([1000, 1003, 1006]);

    m = applyDecPrivateMode(m, 1003, false);
    expect(m.mouseModes).toEqual([1000, 1006]);
    m = applyDecPrivateMode(m, 1049, false);
    expect(m.altScreen).toBe(false);
  });

  it("builds restore escapes with alt before content and mouse after", () => {
    const { beforeContent, afterContent } = buildAttachRestoreEscapes({
      bracketedPaste: true,
      synchronizedOutput: false,
      altScreen: true,
      mouseModes: [1000, 1006],
    });
    expect(beforeContent).toBe("\x1b[?1049h");
    expect(afterContent).toContain("\x1b[?1000;1006h");
    expect(afterContent).toContain("\x1b[?2004h");
    expect(afterContent).not.toContain("2026");
  });

  it("emits empty restore when no modes are active", () => {
    const { beforeContent, afterContent } = buildAttachRestoreEscapes(
      idleAttachModes(),
    );
    expect(beforeContent).toBe("");
    expect(afterContent).toBe("");
  });

  it("restores a zero-based retained cursor with bounded CUP coordinates", () => {
    expect(
      buildAttachCursorEscape({ x: 5, y: 2, cols: 40, rows: 10 }),
    ).toBe("\x1b[3;6H");
    expect(
      buildAttachCursorEscape({ x: 99, y: -2, cols: 40, rows: 10 }),
    ).toBe("\x1b[1;40H");
    expect(
      buildAttachCursorEscape({ x: undefined, y: 2, cols: 40, rows: 10 }),
    ).toBe("");
  });
});
