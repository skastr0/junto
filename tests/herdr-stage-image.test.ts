import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import {
  decodeClipboardImageBase64,
  normalizeImageExtension,
  pastePathPayload,
  stageImageOnHost,
  VELLUM_CLIPBOARD_IMAGE_MAX_BYTES,
} from "../src/main/vellum/herdr/stage-image";

describe("herdr stage-image (vellum-owned)", () => {
  it("normalizes and rejects extensions", () => {
    expect(normalizeImageExtension(".PNG")).toBe("png");
    expect(normalizeImageExtension("jpeg")).toBe("jpg");
    expect(normalizeImageExtension("exe")).toBeUndefined();
  });

  it("decodes base64 and enforces size", () => {
    const ok = decodeClipboardImageBase64("png", Buffer.from("hi").toString("base64"));
    expect(ok).toEqual({ ok: true, extension: "png", bytes: Buffer.from("hi") });

    const empty = decodeClipboardImageBase64("png", "");
    expect(empty.ok).toBe(false);

    const big = Buffer.alloc(VELLUM_CLIPBOARD_IMAGE_MAX_BYTES + 1, 1);
    const oversized = decodeClipboardImageBase64("png", big.toString("base64"));
    expect(oversized.ok).toBe(false);
  });

  it("pastePathPayload wraps path in bracketed paste", () => {
    expect(pastePathPayload("/tmp/a.png")).toBe("\x1b[200~/tmp/a.png\x1b[201~");
  });

  it("stages a local image file with restricted mode", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // tiny fake png header
    const staged = await stageImageOnHost("local", "png", bytes.toString("base64"));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.path).toMatch(/vellum-herdr-images-/);
    expect(staged.path.endsWith(".png")).toBe(true);
    expect(readFileSync(staged.path)).toEqual(bytes);
    rmSync(staged.path, { force: true });
  });

  it("rejects unknown host", async () => {
    const res = await stageImageOnHost("not-a-host", "png", Buffer.from("x").toString("base64"));
    expect(res.ok).toBe(false);
  });
});
