/**
 * A folder for the Files node to open: the 0.11 real-app checks build it
 * under the sandbox, never in the operator's home.
 *
 * `buildFilesFixture(parent)` writes `<parent>/files-root` (the node's root)
 * and `<parent>/files-outside` beside it, which the root reaches only through
 * symlinks, so the scoping checks have something real to refuse. Every file is
 * generated here, so the repo carries no binaries: a 5,000-line TypeScript
 * file for the editor budget, Markdown, a two-page PDF with text, a PNG, an
 * unknown binary, a text file over the 5 MB read cap, deep folders, names with
 * spaces and accents, and a `node_modules` the index must skip.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { parseFilePath, type FilePath } from "../../src/shared/files";

export interface FilesFixture {
  /** The node's root. */
  readonly root: string;
  /** A sibling of the root; nothing in it may be read through the node. */
  readonly outside: string;
  /** Paths relative to the root, the way the renderer names them. */
  readonly paths: Readonly<Record<keyof typeof PATHS, FilePath>>;
  /** Text the PDF carries on each page, for selection and search checks. */
  readonly pdfPageText: readonly [string, string];
  readonly bigTsLines: number;
}

const PATHS = {
  bigTs: "src/big.ts",
  markdown: "README.md",
  pdf: "docs/sample.pdf",
  png: "img/gradient.png",
  unknownBinary: "data/blob.bin",
  tooLarge: "logs/huge.log",
  deep: "nested/a/b/c/deep.txt",
  spaced: "notes/meeting notes.txt",
  accented: "notes/café.md",
  symlinkFileOut: "link-secret.txt",
  symlinkDirOut: "link-outside",
  symlinkInside: "link-readme.md",
  skipped: "node_modules/pkg/index.js",
} as const;

const BIG_TS_LINES = 5000;
const TOO_LARGE_BYTES = 5 * 1024 * 1024 + 1024;
const PDF_PAGE_TEXT = ["Junto fixture page one", "Junto fixture page two"] as const;

const bigTypeScript = (lines: number): string => {
  const out: string[] = ["// Generated for the Files editor budget.", ""];
  let n = 0;
  while (out.length < lines - 1) {
    out.push(
      `export interface Row${n} { readonly id: number; readonly label: string }`,
      `export const row${n} = (id: number): Row${n} => ({ id, label: \`row \${id}\` });`,
      `export function sum${n}(xs: ReadonlyArray<number>): number {`,
      `  return xs.reduce((a, b) => a + b, ${n});`,
      `}`,
      ``,
    );
    n += 1;
  }
  return out.slice(0, lines - 1).join("\n") + "\nexport const END = true;\n";
};

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** An RGB gradient, so a box drawn on it extracts pixels that differ by place. */
const gradientPng = (width: number, height: number): Buffer => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = Math.round((x / (width - 1)) * 255);
      raw[i + 1] = Math.round((y / (height - 1)) * 255);
      raw[i + 2] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** A valid PDF with one line of Helvetica text per page and a correct xref. */
const textPdf = (pages: readonly string[]): Buffer => {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};

const put = async (path: string, data: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
};

export const buildFilesFixture = async (parent: string): Promise<FilesFixture> => {
  const root = join(parent, "files-root");
  const outside = join(parent, "files-outside");
  const paths = Object.fromEntries(
    Object.entries(PATHS).map(([key, raw]) => {
      const path = parseFilePath(raw);
      if (path === undefined) throw new Error(`fixture path refused by the contract: ${raw}`);
      return [key, path];
    }),
  ) as FilesFixture["paths"];

  await put(join(outside, "secret.txt"), "outside the root\n");
  await put(join(root, paths.bigTs), bigTypeScript(BIG_TS_LINES));
  await put(join(root, paths.markdown), "# Fixture\n\nA root for the Files node.\n\n- one\n- two\n");
  await put(join(root, paths.pdf), textPdf(PDF_PAGE_TEXT));
  await put(join(root, paths.png), gradientPng(320, 200));
  await put(join(root, paths.unknownBinary), Buffer.from([0x00, 0xff, 0x13, 0x37, 0x00, 0x01, 0x02, 0x03]));
  await put(join(root, paths.tooLarge), "x".repeat(TOO_LARGE_BYTES));
  await put(join(root, paths.deep), "deep\n");
  await put(join(root, paths.spaced), "spaced name\n");
  await put(join(root, paths.accented), "# Café\n");
  await put(join(root, paths.skipped), "module.exports = 1;\n");
  await symlink(join(outside, "secret.txt"), join(root, paths.symlinkFileOut));
  await symlink(outside, join(root, paths.symlinkDirOut));
  await symlink(join(root, paths.markdown), join(root, paths.symlinkInside));

  return { root, outside, paths, pdfPageText: PDF_PAGE_TEXT, bigTsLines: BIG_TS_LINES };
};
