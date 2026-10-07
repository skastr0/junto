import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachmentMediaType, isInertSvg, sniffRasterType, sniffVideoType } from "@shared/preview-bytes";
import { locatePreviewForReveal, readAttachmentPreview, readPreview, resolvePreviewPath } from "../src/main/junto/preview/read";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir = "";
const at = (name: string): string => join(dir, name);
const read = (text: string | undefined, path: string, variant: "thumb" | "full" = "full") =>
  readPreview({ text, path, variant, thumbEdge: 64 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-preview-"));
  await writeFile(at("shot.png"), PNG);
  await writeFile(at("fake.png"), "this is not an image");
  await writeFile(at("notes.md"), "# Notes\nhello");
  await writeFile(at("secret.key"), "PRIVATE");
  await writeFile(at("binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(at("long.log"), "x".repeat(70_000));
  await writeFile(at("ok.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  await writeFile(at("bad.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await mkdir(at("folder.png"));
  await symlink(at("secret.key"), at("link.txt"));
  await symlink(at("shot.png"), at("link.png"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readPreview guard", () => {
  it("refuses a path the text does not name", async () => {
    expect(await read("nothing here", at("shot.png"))).toEqual({ ok: false, reason: "not-named" });
    expect(await read(undefined, at("shot.png"))).toEqual({ ok: false, reason: "not-named" });
    // Named in another form is still not the same key.
    expect(await read(`see ${at("shot.png")}`, `${at("shot.png")}/../secret.key`)).toEqual({
      ok: false,
      reason: "not-named",
    });
  });

  it("reports a named path that is gone, or is not a regular file, as missing", async () => {
    expect(await read(`a ${at("gone.png")}`, at("gone.png"))).toEqual({ ok: false, reason: "missing" });
    expect(await read(`a ${at("folder.png")}`, at("folder.png"))).toEqual({ ok: false, reason: "missing" });
  });
});

describe("readPreview kinds", () => {
  it("serves an image as a data URL, by its bytes", async () => {
    const result = await read(`Before: ${at("shot.png")}`, at("shot.png"));
    expect(result).toMatchObject({ ok: true, kind: "image", name: "shot.png", mediaType: "image/png", byteLength: PNG.length });
    expect(result.ok && result.kind === "image" && result.dataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("follows a link to an image", async () => {
    expect(await read(at("link.png"), at("link.png"))).toMatchObject({ ok: true, kind: "image", name: "link.png" });
  });

  it("uses the thumbnailer for the thumb variant only", async () => {
    const thumbnail = () => ({ bytes: Buffer.from("small"), mediaType: "image/png" });
    const input = { text: at("shot.png"), path: at("shot.png"), thumbEdge: 64, thumbnail };
    const thumb = await readPreview({ ...input, variant: "thumb" });
    const full = await readPreview({ ...input, variant: "full" });
    expect(thumb.ok && thumb.kind === "image" && thumb.dataUrl).toBe(`data:image/png;base64,${Buffer.from("small").toString("base64")}`);
    expect(full.ok && full.kind === "image" && full.dataUrl).toContain(PNG.toString("base64"));
  });

  it("never serves a file as an image on its extension alone", async () => {
    expect(await read(at("fake.png"), at("fake.png"))).toEqual({
      ok: true,
      kind: "file",
      name: "fake.png",
      byteLength: 20,
      extension: "png",
    });
  });

  it("serves an inert svg and withholds an active one", async () => {
    expect(await read(at("ok.svg"), at("ok.svg"))).toMatchObject({ ok: true, kind: "image", mediaType: "image/svg+xml" });
    expect(await read(at("bad.svg"), at("bad.svg"))).toMatchObject({ ok: true, kind: "file", extension: "svg" });
  });

  it("serves a text file whole, and only its start as the small variant", async () => {
    expect(await read(at("notes.md"), at("notes.md"))).toEqual({
      ok: true,
      kind: "text",
      name: "notes.md",
      byteLength: 13,
      format: "markdown",
      text: "# Notes\nhello",
      truncated: false,
    });
    const long = await read(at("long.log"), at("long.log"));
    expect(long).toMatchObject({ ok: true, kind: "text", truncated: false, byteLength: 70_000 });
    expect(long.ok && long.kind === "text" && long.text.length).toBe(70_000);
    const excerpt = await read(at("long.log"), at("long.log"), "thumb");
    expect(excerpt).toMatchObject({ ok: true, kind: "text", truncated: true, byteLength: 70_000 });
    expect(excerpt.ok && excerpt.kind === "text" && excerpt.text.length).toBe(64 * 1024);
  });

  it("gives only name, type and size for anything else", async () => {
    expect(await read(at("secret.key"), at("secret.key"))).toEqual({
      ok: true,
      kind: "file",
      name: "secret.key",
      byteLength: 7,
      extension: "key",
    });
    expect(await read(at("binary.txt"), at("binary.txt"))).toMatchObject({ ok: true, kind: "file" });
  });

  it("judges a link by what it points at, so a .txt name cannot read another kind of file", async () => {
    expect(await read(at("link.txt"), at("link.txt"))).toEqual({
      ok: true,
      kind: "file",
      name: "link.txt",
      byteLength: 7,
      extension: "key",
    });
  });
});

describe("preview helpers", () => {
  it("resolves only local paths", () => {
    expect(resolvePreviewPath("/tmp/a.png")).toBe("/tmp/a.png");
    expect(resolvePreviewPath("~/a.png", "/Users/me")).toBe("/Users/me/a.png");
    expect(resolvePreviewPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
    expect(resolvePreviewPath("file://remote.host/share/a.png")).toBeUndefined();
    expect(resolvePreviewPath("https://example.com/a.png")).toBeUndefined();
    expect(resolvePreviewPath("a.png")).toBeUndefined();
    expect(resolvePreviewPath("/tmp/a\u0000.png")).toBeUndefined();
  });

  it("knows the raster signatures", () => {
    expect(sniffRasterType(PNG)).toBe("image/png");
    expect(sniffRasterType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffRasterType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffRasterType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffRasterType(Buffer.from("<svg"))).toBeUndefined();
  });

  it("calls an svg inert only when nothing in it runs or loads", () => {
    const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    expect(isInertSvg(svg('<path d="M0 0"/><use href="#a"/>'))).toBe(true);
    expect(isInertSvg(`<?xml version="1.0"?>\n${svg("")}`)).toBe(true);
    expect(isInertSvg(svg('<image href="data:image/png;base64,AAAA"/>'))).toBe(true);
    expect(isInertSvg(svg("<script>1</script>"))).toBe(false);
    expect(isInertSvg(svg("<foreignObject><div/></foreignObject>"))).toBe(false);
    expect(isInertSvg(svg('<rect onload="x()"/>'))).toBe(false);
    expect(isInertSvg(svg('<a href="javascript:x()"/>'))).toBe(false);
    expect(isInertSvg(svg('<image href="https://example.com/a.png"/>'))).toBe(false);
    expect(isInertSvg(svg('<image href="file:///etc/passwd"/>'))).toBe(false);
    expect(isInertSvg(svg('<rect style="fill:url(https://example.com/x)"/>'))).toBe(false);
    expect(isInertSvg(svg('<image href="data:image/svg+xml;base64,AAAA"/>'))).toBe(false);
    expect(isInertSvg("<html><svg></svg></html>")).toBe(false);
  });

  it("reveals only what a read would serve", async () => {
    expect(await locatePreviewForReveal("nothing", at("shot.png"))).toBeUndefined();
    expect(await locatePreviewForReveal(at("gone.png"), at("gone.png"))).toBeUndefined();
    expect(await locatePreviewForReveal(at("shot.png"), at("shot.png"))).toMatch(/shot\.png$/u);
  });
});

describe("attachmentMediaType", () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  it("says an image by its bytes, a drawing and text by their names", () => {
    expect(attachmentMediaType("shot.png", PNG)).toBe("image/png");
    expect(attachmentMediaType("renamed.bin", PNG)).toBe("image/png");
    expect(attachmentMediaType("notes.md", text("# hi"))).toBe("text/markdown");
    expect(attachmentMediaType("change.patch", text("--- a"))).toBe("text/x-diff");
    expect(attachmentMediaType("a.svg", text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
  });

  it("refuses nothing: whatever else it is given is a file", () => {
    expect(attachmentMediaType("fake.png", text("not an image"))).toBe("application/octet-stream");
    expect(attachmentMediaType("build.zip", text("PK"))).toBe("application/octet-stream");
    expect(attachmentMediaType("binary.txt", new Uint8Array([97, 0, 98]))).toBe("application/octet-stream");
    expect(attachmentMediaType("empty.txt", new Uint8Array())).toBe("text/plain");
    expect(attachmentMediaType("id_rsa", text("PRIVATE"))).toBe("application/octet-stream");
  });
});

describe("video", () => {
  const box = (brand: string): Uint8Array =>
    new Uint8Array([0, 0, 0, 20, ...Buffer.from("ftyp"), ...Buffer.from(brand), 0, 0, 2, 0]);
  const EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 31]);

  it("is told by its bytes, whatever it is named", () => {
    expect(sniffVideoType(box("isom"))).toBe("video/mp4");
    expect(sniffVideoType(box("mp42"), "clip.bin")).toBe("video/mp4");
    expect(sniffVideoType(box("qt  "))).toBe("video/quicktime");
    expect(sniffVideoType(EBML)).toBe("video/webm");
    expect(sniffVideoType(EBML, "clip.mkv")).toBe("video/x-matroska");
    // Sound only, a picture, text named as a film: not a video.
    expect(sniffVideoType(box("M4A "))).toBeUndefined();
    expect(sniffVideoType(PNG)).toBeUndefined();
    expect(sniffVideoType(new TextEncoder().encode("not a film"), "fake.mp4")).toBeUndefined();
    expect(attachmentMediaType("walkthrough.bin", box("isom"))).toBe("video/mp4");
    expect(attachmentMediaType("fake.mp4", new TextEncoder().encode("not a film"))).toBe("application/octet-stream");
  });

  it("is played from the app's own address when the app holds it, and is only a file when named by a path", async () => {
    await writeFile(at("clip.mp4"), Buffer.concat([box("isom"), Buffer.alloc(64)]));
    const held = await readAttachmentPreview({
      objectPath: at("clip.mp4"),
      byteLength: 84,
      name: "clip.mp4",
      streamUrl: "junto-content://object/abc",
      variant: "full",
      thumbEdge: 64,
    });
    expect(held).toEqual({ ok: true, kind: "video", name: "clip.mp4", byteLength: 84, mediaType: "video/mp4", url: "junto-content://object/abc" });
    expect(await read(at("clip.mp4"), at("clip.mp4"))).toMatchObject({ ok: true, kind: "file" });
  });
});
