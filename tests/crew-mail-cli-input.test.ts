import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { mailSendInput } from "../src/cli/core/mail-input";

describe("mail send input", () => {
  it("preserves notice fallback across inline, batch, and file prompt inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-crew-cli-"));
    const items = [{ target: "peer-a", text: "Review" }, { target: "peer-b", messageId: "m1" }];
    try {
      const path = join(dir, "prompts.json");
      await writeFile(path, JSON.stringify(items));
      for (const input of [JSON.stringify(items), `@${path}`]) {
        const actual = await Effect.runPromise(mailSendInput({ input, prompt: true, fallback: "notice" }));
        expect(JSON.parse(actual)).toEqual(items.map((item) => ({ ...item, fallback: "notice" })));
      }
      const actual = await Effect.runPromise(mailSendInput({ input: JSON.stringify(items[0]), prompt: true, fallback: "notice" }));
      expect(JSON.parse(actual)).toEqual([{ ...items[0], fallback: "notice" }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects invalid or conflicting policy instead of silently dropping it", async () => {
    for (const input of [
      { input: "{}", prompt: true, fallback: "interrupt" },
      { input: "peer", prompt: false, fallback: "notice" },
      { input: "peer", prompt: true, text: "replacement", retry: "m1" },
      { input: '{"target":"peer","text":"x","fallback":"interrupt"}', prompt: true, fallback: "notice" },
    ]) await expect(Effect.runPromise(mailSendInput(input))).rejects.toThrow();
  });

  it("keeps positional retry on the same durable message without a replacement body", async () => {
    expect(JSON.parse(await Effect.runPromise(mailSendInput({
      input: "peer", prompt: true, retry: "m1", fallback: "notice",
    })))).toEqual({ target: "peer", messageId: "m1", fallback: "notice" });
  });
});
