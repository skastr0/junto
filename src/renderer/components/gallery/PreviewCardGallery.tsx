import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "effect";
import { formatNodeRef } from "@shared/node-ref";
import { applyPatches, type Pad, type PadPatch } from "@shared/pad";
import { SeatUrgency } from "@shared/wire/urgency";
import type { TaskNumber } from "@shared/task-model";
import { ensureMarkAtlas } from "../../lib/activity-atlas";
import type { PreviewCardFace } from "../../lib/preview-face";
import { startSurfaceMotionGate } from "../../lib/surface-motion";
import { PreviewCard, PREVIEW_CARD_BOX } from "../embeds/PreviewCard";
import { padCardFor } from "../pad/pad-card";
import { PadEditor, type PadPins } from "../pad/PadEditor";
import type { PadCommitOutcome } from "../pad/pad-editor-model";
import { Eyebrow } from "../ui";

/**
 * Dev gallery for the preview card: every kind and load state a document embeds or a pad holds,
 * as a block at the document's width and as a pad card at its default box and a resized one.
 * Route: `#/gallery/previews`. Opening a card counts here instead of going anywhere.
 */

const S = SeatUrgency.group;
const SEAT = "agent-01M46TX8WR2Q4YGKZ6NFW4GTG8";
const BUILDER = "agent-01M46TX8WRVQYSPHE3C9WCAC9W";
const ITEM = "01M5Y9Q544EFBXQMPY7WCNVWMT";

const SECTIONS: ReadonlyArray<{ readonly word: string; readonly faces: ReadonlyArray<PreviewCardFace> }> = [
  {
    word: "Task",
    faces: [
      { kind: "task", id: ITEM, number: 42 as TaskNumber, title: "Fix the tab strip at narrow widths", state: "working", assignee: { id: BUILDER, name: "product-automation", harness: "claude" }, ledger: { finished: 2, open: 1, asks: 0, stuck: 0, backlog: 0 } },
      { kind: "task", id: ITEM, number: 43 as TaskNumber, title: "Pick the release name", state: "input-required", assignee: { id: SEAT, name: "product-attention", harness: "claude" }, ledger: { finished: 0, open: 0, asks: 1, stuck: 0, backlog: 0 } },
      { kind: "task", id: ITEM, number: 44 as TaskNumber, title: "Ship 0.10.3", state: "in-review", assignee: { id: BUILDER, name: "product-automation", harness: "codex" }, ledger: { finished: 3, open: 1, asks: 0, stuck: 0, backlog: 0 } },
      { kind: "task", id: ITEM, number: 45 as TaskNumber, title: "Write the release notes", state: "done", assignee: { id: SEAT, name: "product-attention" }, ledger: { finished: 4, open: 0, asks: 0, stuck: 0, backlog: 0 } },
      { kind: "task", id: ITEM, number: 46 as TaskNumber, title: "Someday, a dark sound pack", state: "backlog", ledger: { finished: 0, open: 0, asks: 0, stuck: 0, backlog: 1 } },
    ],
  },
  {
    word: "Seat",
    faces: [
      { kind: "seat", id: SEAT, name: "product-attention", harness: "claude", state: S.working, line: "bun run test" },
      { kind: "seat", id: BUILDER, name: "product-automation", harness: "codex", state: S.waiting, line: "permission to run e2e/scenarios" },
      { kind: "seat", id: SEAT, name: "product-attention", harness: "claude", state: S.blocked, line: "needs the prod DB password" },
      { kind: "seat", id: BUILDER, name: "product-automation", state: S.done, line: "turn finished" },
      { kind: "seat", id: SEAT, name: "product-attention", state: S.offline, line: "exited" },
    ],
  },
  {
    word: "Artifact",
    faces: [
      { kind: "artifact", id: ITEM, type: "document", title: "0.10.3 plan", version: 7, lines: ["One preview card for every embed", "Documents first, pads after the Excalidraw spike"] },
      { kind: "artifact", id: ITEM, type: "sheet", title: "Seat roster", version: 2, lines: ["Seat, Region, Lead", "product-attention, Attention, product-lead"] },
      { kind: "artifact", id: ITEM, type: "pad", title: "Feed sketch", version: 12, lines: ["8 shapes, 3 strokes"] },
      { kind: "artifact", id: ITEM, type: "link", title: "RFC 42", version: 1, lines: ["https://example.com/rfc/42"] },
      { kind: "artifact", id: ITEM, type: "file", title: "plan.pdf", version: 1, lines: [] },
    ],
  },
  {
    word: "Page and missing",
    faces: [
      { kind: "page", id: SEAT, title: "docs.example.com", url: "https://docs.example.com/guide/start", state: S.resting },
      { kind: "missing", label: "#7 Old tabs task", reason: "loading", of: "task" },
      { kind: "missing", label: "Retired plan", reason: "gone", of: "artifact" },
      { kind: "missing", label: "@old-seat", reason: "gone", of: "seat" },
    ],
  },
];

const NO_PINS: PadPins = { kind: "none" };

/** A pad with two cards joined to a box: the editor's own gestures move, resize and connect them. */
const seedPad = (): Pad => {
  const empty: Pad = { revision: 0, images: [], shapes: [], edges: [], inks: [] };
  const seat = padCardFor({ href: formatNodeRef({ canvasName: "gallery", nodeId: SEAT }), label: "product-attention" }, { x: 220, y: 120 }, empty, () => "seat");
  const task = padCardFor({ href: `${formatNodeRef({ canvasName: "gallery", nodeId: "task-01M5G1KYYMFQASGJKGBDQZA2D3" })}&item=${ITEM}`, label: "#42 Fix the tab strip" }, { x: 220, y: 300 }, { shapes: [seat.shape] }, () => "task");
  const patches: PadPatch[] = [
    seat.patch,
    task.patch,
    { op: "upsert", layer: "shape", shape: { id: "box-plan" as never, type: "box", x: 520, y: 170, w: 160, h: 90, z: 2, text: "Release" } },
    { op: "upsert", layer: "edge", edge: { id: "edge-seat" as never, from: seat.shape.id, to: "box-plan" as never } },
    { op: "upsert", layer: "edge", edge: { id: "edge-task" as never, from: task.shape.id, to: "box-plan" as never } },
  ];
  return Result.getOrThrow(applyPatches(empty, patches));
};

/** The pad editor over local state: cards here name nothing on this page, so they draw missing under their labels. */
function GalleryPad() {
  const [pad, setPad] = useState<Pad>(seedPad);
  const padRef = useRef(pad);
  padRef.current = pad;
  const onCommit = useCallback(async (patches: ReadonlyArray<PadPatch>): Promise<PadCommitOutcome> => {
    const next = applyPatches(padRef.current, patches);
    if (Result.isFailure(next)) return { ok: false, message: next.failure.message };
    setPad(next.success);
    return { ok: true, pad: next.success };
  }, []);
  const onReadPad = useCallback(async () => padRef.current, []);
  const onClose = useCallback(() => {}, []);
  return (
    <div className="pad-surface relative flex h-[460px] min-h-0 flex-col overflow-hidden rounded-lg border border-stroke" data-testid="gallery-pad">
      <PadEditor pad={pad} pins={NO_PINS} onCommit={onCommit} onReadPad={onReadPad} onClose={onClose} cards={{ candidates: [] }} />
    </div>
  );
}

export function PreviewCardGallery() {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    ensureMarkAtlas("dark");
    ensureMarkAtlas("bright");
    return startSurfaceMotionGate();
  }, []);
  return (
    <main className="h-screen overflow-auto bg-ground text-ink">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-6 px-6 py-6">
        <header>
          <Eyebrow tone="amber">Junto dev gallery</Eyebrow>
          <h1 className="font-display text-hero uppercase leading-none tracking-soft text-ink">Preview cards</h1>
          <p className="mt-2 max-w-[780px] text-body text-dim">
            A Junto thing embedded in an artifact, in the kind seat's language. A block is the document's width and one height for every
            kind; only its title opens. A pad card fills the box it is given, and opens anywhere.
          </p>
          <p className="mt-1 text-label text-faint" data-testid="preview-gallery-opened">
            {opened === null ? "Nothing opened yet" : `Opened ${opened}`}
          </p>
        </header>
        <section className="grid gap-3">
          <h2 className="text-body font-semibold text-ink">On a pad</h2>
          <GalleryPad />
        </section>
        {SECTIONS.map((section) => (
          <section key={section.word} className="grid gap-3">
            <h2 className="text-body font-semibold text-ink">{section.word}</h2>
            <div className="grid items-start gap-4" style={{ gridTemplateColumns: "minmax(0, 640px) 1fr" }}>
              <div className="grid gap-2">
                {section.faces.map((face, index) => (
                  <PreviewCard key={index} {...face} size="block" onOpen={() => setOpened(`${face.kind} ${index + 1}, block`)} />
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                {section.faces.map((face, index) => (
                  <div key={index} style={index === 0 ? { width: 220, height: 96 } : PREVIEW_CARD_BOX}>
                    <PreviewCard {...face} size="card" onOpen={() => setOpened(`${face.kind} ${index + 1}, card`)} />
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
