import { describe, expect, it } from "vitest";
import { COMMAND_ROW_MAX_BYTES } from "../src/shared/resource-command";
import { MAIL_ENVELOPE_BYTES, MAIL_TEXT_INLINE_MAX_BYTES, mailTextBytes, textCarriage } from "../src/shared/mail-text-bound";
import { longTextOf } from "../src/renderer/lib/long-text";

describe("a composer's text bound", () => {
  it("leaves the row its envelope", () => {
    expect(MAIL_TEXT_INLINE_MAX_BYTES + MAIL_ENVELOPE_BYTES).toBe(COMMAND_ROW_MAX_BYTES);
  });

  it("measures text as the row does, escapes and all", () => {
    expect(mailTextBytes("abc")).toBe(3);
    expect(mailTextBytes('a"b\n')).toBe(6);
    expect(mailTextBytes("é")).toBe(2);
    expect(mailTextBytes("\u0001")).toBe(6);
  });

  it("sends inline up to the bound and as a file past it", () => {
    expect(textCarriage("x".repeat(MAIL_TEXT_INLINE_MAX_BYTES))).toEqual({ kind: "inline" });
    expect(textCarriage("x".repeat(MAIL_TEXT_INLINE_MAX_BYTES + 1))).toEqual({ kind: "file", bytes: MAIL_TEXT_INLINE_MAX_BYTES + 1 });
    // Newlines cost two bytes each in the row, so half as many go past it.
    expect(textCarriage("\n".repeat(MAIL_TEXT_INLINE_MAX_BYTES / 2 + 1)).kind).toBe("file");
    expect(textCarriage("x".repeat(9), { bytes: 100, characters: 8 }).kind).toBe("file");
  });

  it("says so before send, and waits when the tray has no room", () => {
    const long = "x".repeat(MAIL_TEXT_INLINE_MAX_BYTES + 1);
    expect(longTextOf("short", 0)).toEqual({ carriage: { kind: "inline" }, notice: undefined, blocked: false });
    expect(longTextOf(long, 0)).toMatchObject({ notice: "Over 40 KB, so this goes as message.md, attached", blocked: false });
    expect(longTextOf(long, 10)).toMatchObject({ blocked: true });
    expect(longTextOf("x".repeat(9000), 0, { bytes: MAIL_TEXT_INLINE_MAX_BYTES, characters: 8000 }).notice).toBe(
      "Over 8,000 characters, so this goes as message.md, attached",
    );
  });
});
