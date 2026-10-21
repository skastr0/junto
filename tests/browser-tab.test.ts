import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CloseRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  StopRequest,
} from "../src/shared/browser-control";
import { BrowserTabId, isValidBrowserTabId } from "../src/shared/browser-tab";

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Result.isSuccess(
    Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(value),
  );

describe("browser tab contract", () => {
  it("accepts bounded ASCII tab ids and refuses the rest", () => {
    for (const id of ["tab-1", "t", "01M5ESM39SJM1SAC42GQ645308", "a.b:c_d-e"]) {
      expect(isValidBrowserTabId(id)).toBe(true);
    }
    for (const id of ["", "-lead", "tab 1", "táb", "x".repeat(4_097), 7, null]) {
      expect(isValidBrowserTabId(id)).toBe(false);
    }
  });

  it("is a brand: a plain string is not a tab id until it is decoded", () => {
    expectTypeOf<string>().not.toEqualTypeOf<BrowserTabId>();
    expectTypeOf<BrowserTabId>().toExtend<string>();
    const decoded = Schema.decodeUnknownSync(BrowserTabId)("tab-1");
    expectTypeOf(decoded).toEqualTypeOf<BrowserTabId>();
  });

  it("lets open, goto, eval and shot name a tab, and acts on the active tab without one", () => {
    const withTab = [
      [OpenRequest, { ref: "junto://canvas/work?node=page-1" }],
      [GotoRequest, { sessionId: "s1", url: "https://example.com/" }],
      [EvalRequest, { sessionId: "s1", code: "1" }],
      [ScreenshotRequest, { sessionId: "s1" }],
    ] as const;
    for (const [schema, body] of withTab) {
      expect(decodes(schema, body)).toBe(true);
      expect(decodes(schema, { ...body, tab: "tab-2" })).toBe(true);
      expect(decodes(schema, { ...body, tab: "" })).toBe(false);
    }
    expectTypeOf<GotoRequest["tab"]>().toEqualTypeOf<BrowserTabId | undefined>();
  });

  it("keeps close and stop page-wide", () => {
    expect(decodes(CloseRequest, { sessionId: "s1", tab: "tab-2" })).toBe(false);
    expect(decodes(StopRequest, { sessionId: "s1", tab: "tab-2" })).toBe(false);
  });
});
