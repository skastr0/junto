import { describe, expect, it } from "vitest";
import {
  extensionFromFileName,
  extensionFromMime,
  extractHerdrClipboardImage,
  fileToHerdrClipboardImage,
  HERDR_CLIPBOARD_IMAGE_MAX_BYTES,
  uint8ToBase64,
} from "../src/renderer/lib/herdr-clipboard-image";

describe("herdr clipboard image helpers", () => {
  it("maps image mimes and file names to herdr extensions", () => {
    expect(extensionFromMime("image/png")).toBe("png");
    expect(extensionFromMime("image/jpeg; charset=binary")).toBe("jpg");
    expect(extensionFromMime("text/plain")).toBeUndefined();
    expect(extensionFromFileName("shot.PNG")).toBe("png");
    expect(extensionFromFileName("photo.jpeg")).toBe("jpg");
    expect(extensionFromFileName("notes.txt")).toBeUndefined();
  });

  it("encodes binary to base64", () => {
    expect(uint8ToBase64(new Uint8Array([104, 105]))).toBe(btoa("hi"));
  });

  it("fileToHerdrClipboardImage rejects empty and oversized payloads", async () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    expect(await fileToHerdrClipboardImage(empty)).toEqual({ error: "empty image" });

    const oversized = new File(
      [new Uint8Array(HERDR_CLIPBOARD_IMAGE_MAX_BYTES + 1)],
      "big.png",
      { type: "image/png" },
    );
    const result = await fileToHerdrClipboardImage(oversized);
    expect(result).toMatchObject({ error: expect.stringContaining("too large") });
  });

  it("fileToHerdrClipboardImage encodes a small png", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new File([bytes], "clip.png", { type: "image/png" });
    const result = await fileToHerdrClipboardImage(file);
    expect(result).toEqual({
      extension: "png",
      dataBase64: uint8ToBase64(bytes),
      byteLength: 4,
    });
  });

  it("extractHerdrClipboardImage returns null when no image is present", async () => {
    const dt = {
      items: [] as unknown as DataTransferItemList,
      files: { length: 0, item: () => null } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(await extractHerdrClipboardImage(dt)).toBeNull();
    expect(await extractHerdrClipboardImage(null)).toBeNull();
  });

  it("extractHerdrClipboardImage reads image files from FileList", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const file = new File([bytes], "drop.webp", { type: "image/webp" });
    const dt = {
      items: [] as unknown as DataTransferItemList,
      files: {
        length: 1,
        0: file,
        item: (i: number) => (i === 0 ? file : null),
        [Symbol.iterator]: function* () {
          yield file;
        },
      } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(await extractHerdrClipboardImage(dt)).toEqual({
      extension: "webp",
      dataBase64: uint8ToBase64(bytes),
      byteLength: 3,
    });
  });
});
