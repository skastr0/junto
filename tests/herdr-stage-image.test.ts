import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import type { RunSsh } from "../src/main/vellum/herdr/stage-image";
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

  it("rejects oversized base64 before decode", () => {
    const huge = "A".repeat(Math.ceil((VELLUM_CLIPBOARD_IMAGE_MAX_BYTES * 4) / 3) + 32);
    const res = decodeClipboardImageBase64("png", huge);
    expect(res.ok).toBe(false);
  });

  describe("remote remote-a via mocked runSsh", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const b64 = bytes.toString("base64");

    it("mkdir then write success → path under /tmp/vellum-herdr-images/", async () => {
      const calls: Array<{ target: string; cmd: string; stdin?: Buffer }> = [];
      const runSsh: RunSsh = async (target, remoteCommand, stdin) => {
        calls.push({ target, cmd: remoteCommand, stdin });
        return { ok: true };
      };

      const staged = await stageImageOnHost("remote-a", "png", b64, { runSsh });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;

      expect(staged.path).toMatch(/^\/tmp\/vellum-herdr-images\/vellum-clip-.+\.png$/);
      expect(staged.byteLength).toBe(bytes.byteLength);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.target).toBe("remote-a");
      expect(calls[0]?.cmd).toMatch(/mkdir -p '\/tmp\/vellum-herdr-images'/);
      expect(calls[0]?.cmd).toMatch(/chmod 700 '\/tmp\/vellum-herdr-images'/);
      expect(calls[0]?.stdin).toBeUndefined();
      expect(calls[1]?.target).toBe("remote-a");
      expect(calls[1]?.cmd).toContain(`cat > '${staged.path}'`);
      expect(calls[1]?.cmd).toContain(`chmod 600 '${staged.path}'`);
      expect(calls[1]?.stdin).toEqual(bytes);
    });

    it("mkdir fail short-circuits (no write)", async () => {
      const calls: string[] = [];
      const runSsh: RunSsh = async (_t, cmd) => {
        calls.push(cmd);
        return { ok: false, error: "permission denied" };
      };

      const res = await stageImageOnHost("remote-a", "png", b64, { runSsh });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/remote mkdir failed/);
      expect(res.error).toMatch(/permission denied/);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/mkdir -p/);
    });

    it("write fail after mkdir success", async () => {
      let n = 0;
      const runSsh: RunSsh = async () => {
        n += 1;
        if (n === 1) return { ok: true };
        return { ok: false, error: "disk full" };
      };

      const res = await stageImageOnHost("remote-a", "png", b64, { runSsh });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/remote write failed/);
      expect(res.error).toMatch(/disk full/);
      expect(n).toBe(2);
    });
  });
});
