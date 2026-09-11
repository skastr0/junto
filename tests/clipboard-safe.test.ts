import { describe, expect, it } from "vitest";
import { clipboardFormatsAreSafeForGrok } from "../src/main/vellum-command/term/drive/clipboard-safe";

describe("Grok clipboard format safety", () => {
  it("accepts text-only pasteboard metadata", () => {
    expect(
      clipboardFormatsAreSafeForGrok([
        "text/plain",
        "public.utf8-plain-text",
      ]),
    ).toBe(true);
  });

  it.each([
    "image/png",
    "public.png",
    "public.jpeg",
    "TIFF",
    "com.compuserve.gif",
  ])("rejects image format %s without reading clipboard contents", (format) => {
    expect(clipboardFormatsAreSafeForGrok([format])).toBe(false);
  });
});
