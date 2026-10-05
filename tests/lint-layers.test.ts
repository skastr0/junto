import { describe, expect, it } from "vitest";
import { nativeDialogLines, rawLayerValues } from "../scripts/lint-layers";

describe("layer gate", () => {
  it("flags a layer-sized number in css, an inline style and a tailwind class", () => {
    expect(rawLayerValues(".a { z-index: 10000; }")).toEqual([{ line: 1, value: 10000 }]);
    expect(rawLayerValues("const style = { zIndex: 10020 };")).toEqual([{ line: 1, value: 10020 }]);
    expect(rawLayerValues('<div className="fixed z-[120]" />')).toEqual([{ line: 1, value: 120 }]);
  });

  it("reports the line", () => {
    expect(rawLayerValues(".a {\n  color: red;\n  z-index: 500;\n}")).toEqual([{ line: 3, value: 500 }]);
  });

  it("leaves tokens and local stacking alone", () => {
    expect(rawLayerValues(".a { z-index: var(--layer-working); }")).toEqual([]);
    expect(rawLayerValues('zIndex: "var(--layer-flyout)"')).toEqual([]);
    expect(rawLayerValues(".a { z-index: 40; } .b { z-index: 1; }")).toEqual([]);
    expect(rawLayerValues('<div className="z-[80] z-20" />')).toEqual([]);
  });
});

describe("native dialog gate", () => {
  it("flags window.confirm, alert and prompt, called or only named", () => {
    expect(nativeDialogLines("if (!window.confirm(message)) return;")).toEqual([1]);
    expect(nativeDialogLines("const ok =\n  confirm('sure?');")).toEqual([2]);
    expect(nativeDialogLines("alert(text);\nconst name = prompt('name');")).toEqual([1, 2]);
    expect(nativeDialogLines('typeof window.confirm !== "function"')).toEqual([1]);
  });

  it("leaves the app's own confirm alone", () => {
    expect(nativeDialogLines("void askConfirm({ title });")).toEqual([]);
    expect(nativeDialogLines("const confirmDelete = () => onConfirm();")).toEqual([]);
    expect(nativeDialogLines("dialog.confirm(); toast.alert(message);")).toEqual([]);
    expect(nativeDialogLines("// was window.confirm(message)")).toEqual([]);
  });
});
