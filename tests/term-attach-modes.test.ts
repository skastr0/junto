import { describe, expect, it } from "vitest";
import {
  applyDecPrivateMode,
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
});
