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
        return [modelFile(entry.id, x, y, entry.id === "gal-file-img" ? "/tmp/cover.png" : `/tmp/${entry.id}.txt`)];
      case "note": return [modelNote(entry.id, "A note on the gallery\nSecond line.", x, y)];
      case "label": return [modelLabel(entry.id, "A label", x, y)];
      case "peer": return [modelPeer(entry.id, x, y)];
      case "stub": return [modelStub(entry.id, "git", x, y)];
      default: return [];
    }
  }),
]);
