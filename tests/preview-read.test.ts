import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAttachment, isInertSvg, sniffRasterType } from "@shared/preview-bytes";
import { locatePreviewForReveal, readPreview, resolvePreviewPath } from "../src/main/junto/preview/read";

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

  it("serves the head of a text file and says when there is more", async () => {
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
    expect(long).toMatchObject({ ok: true, kind: "text", truncated: true, byteLength: 70_000 });
    expect(long.ok && long.kind === "text" && long.text.length).toBe(64 * 1024);
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

describe("classifyAttachment", () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  it("admits an image by its bytes and text by its name", () => {
    expect(classifyAttachment("shot.png", PNG)).toEqual({ ok: true, kind: "image", mediaType: "image/png" });
    expect(classifyAttachment("renamed.bin", PNG)).toEqual({ ok: true, kind: "image", mediaType: "image/png" });
    expect(classifyAttachment("notes.md", text("# hi"))).toEqual({ ok: true, kind: "text", mediaType: "text/markdown" });
    expect(classifyAttachment("change.patch", text("--- a"))).toEqual({ ok: true, kind: "text", mediaType: "text/x-diff" });
    expect(classifyAttachment("a.svg", text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({ ok: true, kind: "image" });
  });

  it("refuses what a preview cannot show", () => {
    expect(classifyAttachment("fake.png", text("not an image")).ok).toBe(false);
    expect(classifyAttachment("a.svg", text("<svg><script/></svg>")).ok).toBe(false);
    expect(classifyAttachment("build.zip", text("PK")).ok).toBe(false);
    expect(classifyAttachment("binary.txt", new Uint8Array([97, 0, 98])).ok).toBe(false);
    expect(classifyAttachment("empty.png", new Uint8Array()).ok).toBe(false);
    expect(classifyAttachment("id_rsa", text("PRIVATE")).ok).toBe(false);
  });
});
