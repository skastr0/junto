import { describe, expect, it } from "vitest";
import {
  extensionFromFileName,
  extensionFromMime,
  extractHerdrClipboardImage,
  fileToHerdrClipboardImage,
  VELLUM_CLIPBOARD_IMAGE_MAX_BYTES,
  uint8ToBase64,
} from "../src/renderer/lib/herdr-clipboard-image";

describe("herdr clipboard image helpers", () => {
  it("maps image mimes and file names to herdr extensions", () => {
    expect(extensionFromMime("image/png")).toBe("png");
    expect(extensionFromMime("image/jpeg; charset=binary")).toBe("jpg");
    expect(extensionFromMime("text/plain")).toBeUndefined();
    expect(extensionFromMime("image/svg+xml")).toBeUndefined();
    expect(extensionFromMime("image/heic")).toBeUndefined();
    expect(extensionFromFileName("shot.PNG")).toBe("png");
    expect(extensionFromFileName("photo.jpeg")).toBe("jpg");
    expect(extensionFromFileName("notes.txt")).toBeUndefined();
    expect(extensionFromFileName("icon.svg")).toBeUndefined();
    expect(extensionFromFileName("photo.heic")).toBeUndefined();
  });

  it("encodes binary to base64", () => {
    expect(uint8ToBase64(new Uint8Array([104, 105]))).toBe(btoa("hi"));
  });

  it("fileToHerdrClipboardImage rejects empty and oversized payloads", async () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    expect(await fileToHerdrClipboardImage(empty)).toEqual({ error: "empty image" });

    const oversized = new File(
      [new Uint8Array(VELLUM_CLIPBOARD_IMAGE_MAX_BYTES + 1)],
      "big.png",
      { type: "image/png" },
    );
    const result = await fileToHerdrClipboardImage(oversized);
    expect(result).toMatchObject({ error: expect.stringContaining("too large") });
  });

  it("fileToHerdrClipboardImage rejects unmappable image types", async () => {
    const svg = new File([new Uint8Array([1])], "icon.svg", { type: "image/svg+xml" });
    expect(await fileToHerdrClipboardImage(svg)).toEqual({
      error: "clipboard image type not allowed: image/svg+xml",
    });

    const heic = new File([new Uint8Array([1])], "photo.heic", { type: "image/heic" });
    expect(await fileToHerdrClipboardImage(heic)).toEqual({
      error: "clipboard image type not allowed: image/heic",
    });

    const tiff = new File([new Uint8Array([1])], "scan.tiff", { type: "image/tiff" });
    expect(await fileToHerdrClipboardImage(tiff)).toMatchObject({
      error: expect.stringContaining("not allowed"),
    });
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

  it("fileToHerdrClipboardImage accepts webp", async () => {
    const bytes = new Uint8Array([5, 6]);
    const file = new File([bytes], "clip.webp", { type: "image/webp" });
    expect(await fileToHerdrClipboardImage(file)).toEqual({
      extension: "webp",
      dataBase64: uint8ToBase64(bytes),
      byteLength: 2,
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

  it("extractHerdrClipboardImage errors on unmappable image/* (svg/heic)", async () => {
    const svg = new File([new Uint8Array([1])], "icon.svg", { type: "image/svg+xml" });
    const dt = {
      items: [
        {
          kind: "file",
          type: "image/svg+xml",
          getAsFile: () => svg,
        },
      ] as unknown as DataTransferItemList,
      files: { length: 0, item: () => null } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(await extractHerdrClipboardImage(dt)).toEqual({
      error: "clipboard image type not allowed: image/svg+xml",
    });

    const heic = new File([new Uint8Array([1])], "photo.heic", { type: "image/heic" });
    const dtHeic = {
      items: [] as unknown as DataTransferItemList,
      files: {
        length: 1,
        0: heic,
        item: (i: number) => (i === 0 ? heic : null),
        [Symbol.iterator]: function* () {
          yield heic;
        },
      } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(await extractHerdrClipboardImage(dtHeic)).toEqual({
      error: "clipboard image type not allowed: image/heic",
    });
  });
});
