import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { writeMailCarryingText } from "../src/main/junto/content/mail-text-file";
import { ContentService } from "../src/main/junto/content/service";
import type { ContentRef } from "../src/shared/wire/content-ref";

const fileRef = { sha256: "b".repeat(64), byteLength: 5, mediaType: "text/markdown", displayName: "message.md" } as ContentRef;
const shot = { sha256: "a".repeat(64), byteLength: 1, mediaType: "image/png", displayName: "shot.png" } as ContentRef;
const owner = { kind: "mail", id: "m1" } as never;
const tooLarge = { ok: false as const, message: "too large", details: { reason: "row_too_large" } };

const run = <A>(effect: Effect.Effect<A, never, ContentService>, put = vi.fn(() => Effect.succeed({ ref: fileRef } as never))) =>
  Effect.runPromise(Effect.provideService(effect, ContentService, { put } as never)).then((value) => ({ value, put }));

describe("main's fallback for a mail whose row is too large", () => {
  it("writes the mail once when it fits", async () => {
    const write = vi.fn(() => Effect.succeed({ ok: true as const, data: "m1" }));
    const { value, put } = await run(writeMailCarryingText(write, { text: "hello", attachments: [shot], owner, filesText: "attached" }));
    expect(value).toEqual({ written: { ok: true, data: "m1" }, attachments: [shot] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("stores the text as message.md, held by the mail, and writes again with it last", async () => {
    const write = vi.fn((text: string) => Effect.succeed(text === "attached" ? { ok: true as const, data: "m1" } : tooLarge));
    const { value, put } = await run(writeMailCarryingText(write, { text: "hello", attachments: [shot], owner, filesText: "attached" }));
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "text/markdown", displayName: "message.md", owner }));
    expect(write).toHaveBeenLastCalledWith("attached", [shot, fileRef]);
    expect(value).toEqual({ written: { ok: true, data: "m1" }, attachments: [shot, fileRef] });
  });

  it("answers any other refusal as it came, and a text-less mail is not retried", async () => {
    const refused = { ok: false as const, message: "nope", details: { reason: "not_permitted" } };
    const other = await run(writeMailCarryingText(() => Effect.succeed(refused), { text: "hi", attachments: [], owner, filesText: "x" }));
    expect(other.value.written).toBe(refused);
    expect(other.put).not.toHaveBeenCalled();
    const empty = await run(writeMailCarryingText(() => Effect.succeed(tooLarge), { text: " ", attachments: [shot], owner, filesText: "x" }));
    expect(empty.value).toEqual({ written: tooLarge, attachments: [shot] });
  });
});
