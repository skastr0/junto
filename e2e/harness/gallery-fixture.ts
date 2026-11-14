/**
 * The look-gallery fixture (docs/canvas-gpu-plan.md, section 7; the kind list
 * is docs/canvas-gpu-inventory/cards.md section 1). One node of every card
 * kind on one canvas, laid out in a grid inside a region, so the DOM canvas
 * and the GPU engine can be compared card by card.
 *
 * `GALLERY_ENTRIES` is the ordered { id, kind } list the comparison walks;
 * `GALLERY_IDS` is the same ids flat. `GALLERY_LIVE` names ids a spec puts
 * into a live state (blocked, working, selected) on top of the fixture —
 * empty until a state source exists; the matrix spec owns those.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Schema } from "effect";
import { contentObjectUrl } from "../../src/shared/content-url";
import { ContentRef } from "../../src/shared/wire/content-ref";
import {
  modelArtifacts,
  modelAutomations,
  modelFile,
  modelFiles,
  modelFixture,
  modelGit,
  modelLabel,
  modelLink,
  modelNote,
  modelPage,
  modelPeer,
  modelRegion,
  modelSeat,
  modelStub,
  modelTask,
  modelTerminal,
} from "./model";
import type { ModelFixture } from "./model";

export interface GalleryEntry {
  readonly id: string;
  readonly kind: string;
}

const COLS = 4;
const DX = 300;
const DY = 180;
const at = (index: number): { readonly x: number; readonly y: number } => ({
  x: (index % COLS) * DX - 450,
  y: Math.floor(index / COLS) * DY - 400,
});

const entries: GalleryEntry[] = [
  { id: "gal-agent-a", kind: "agent" },
  { id: "gal-agent-b", kind: "agent" },
  { id: "gal-terminal", kind: "terminal" },
  { id: "gal-task", kind: "task" },
  { id: "gal-artifacts", kind: "artifacts" },
  { id: "gal-automations", kind: "automations" },
  { id: "gal-git", kind: "git" },
  { id: "gal-files", kind: "files" },
  { id: "gal-page", kind: "page" },
  { id: "gal-link", kind: "link" },
  { id: "gal-file-doc", kind: "file" },
  { id: "gal-file-img", kind: "file" },
  { id: "gal-note", kind: "note" },
  { id: "gal-label", kind: "label" },
  { id: "gal-peer", kind: "peer" },
  { id: "gal-stub", kind: "stub" },
  { id: "gal-region", kind: "region" },
];

export const GALLERY_ENTRIES: ReadonlyArray<GalleryEntry> = entries;
export const GALLERY_IDS: ReadonlyArray<string> = entries.map((entry) => entry.id);
export const GALLERY_LIVE: ReadonlyArray<string> = [];

/**
 * The image-file entry's bytes: a small RGB gradient, encoded once here so
 * the sha256 — and therefore the content URL — is stable. A spec seeds the
 * same bytes into the sandbox content store (writeFixtureContentObject)
 * before boot, so `junto-content://` resolves to a verified object and
 * isImageFile takes the image branch on both canvases.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
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

const gradientPng = (width: number, height: number): Buffer => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
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

export const GALLERY_IMAGE_BYTES: Buffer = gradientPng(96, 64);
export const GALLERY_IMAGE_SHA256: string = createHash("sha256").update(GALLERY_IMAGE_BYTES).digest("hex");
export const GALLERY_IMAGE_URL: string = contentObjectUrl(Schema.decodeSync(ContentRef)({
  sha256: GALLERY_IMAGE_SHA256,
  byteLength: GALLERY_IMAGE_BYTES.byteLength,
  mediaType: "image/png",
  displayName: "cover.png",
}));

const nodeAt = (index: number) => at(index);

export const galleryFixture: ModelFixture = modelFixture([
  modelRegion({ id: "gal-region", label: "Gallery", x: -700, y: -560, width: 1500, height: 1100, z: 0 }),
  ...entries.flatMap((entry, index) => {
    if (entry.kind === "region") return [];
    const { x, y } = nodeAt(index);
    switch (entry.kind) {
      case "agent":
        return [modelSeat({ id: entry.id, label: entry.id === "gal-agent-a" ? "Ada" : "Bex", x, y })];
      case "terminal":
        return [modelTerminal({ id: entry.id, bindingId: `binding-${entry.id}`, label: "Shell", x, y })];
      case "task": return [modelTask(entry.id, x, y)];
      case "artifacts": return [modelArtifacts(entry.id, x, y)];
      case "automations": return [modelAutomations(entry.id, x, y)];
      case "git": return [modelGit(entry.id, x, y)];
      case "files": return [modelFiles(entry.id, x, y)];
      case "page": return [modelPage(entry.id, x, y)];
      case "link": return [modelLink(entry.id, x, y)];
      case "file":
        return [modelFile(entry.id, x, y, entry.id === "gal-file-img" ? GALLERY_IMAGE_URL : `/tmp/${entry.id}.txt`)];
      case "note": return [modelNote(entry.id, "A note on the gallery\nSecond line.", x, y)];
      case "label": return [modelLabel(entry.id, "A label", x, y)];
      case "peer": return [modelPeer(entry.id, x, y)];
      case "stub": return [modelStub(entry.id, "git", x, y)];
      default: return [];
    }
  }),
]);
