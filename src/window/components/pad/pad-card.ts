import { isCanonicalCanvasName } from "@shared/canvas-name";
import { mentionHref, type MentionRef } from "@shared/mention";
import type { Pad, PadPatch, PadPoint, PadShape } from "@shared/pad";
import { parsePreviewLink } from "../../lib/preview-face";
import { PREVIEW_CARD_BOX } from "../embeds/PreviewCard";
import { newPadElementId, nextLayerZ } from "./pad-editor-model";

/** What a card is made from: the href it names and the words its writer saw. */
export type PadCardSource = { readonly href: string; readonly label: string };

/** The longest label a card shape holds (shared/pad.ts). */
const CARD_LABEL_MAX = 200;

/** A label as a card keeps it: one line, at most the pad's limit. */
const cardLabel = (label: string): string => {
  const line = label.replace(/\s+/gu, " ").trim();
  return line.length <= CARD_LABEL_MAX ? line : `${line.slice(0, CARD_LABEL_MAX - 1)}…`;
};

/**
 * A pasted or dropped text that names one Junto thing: a bare `junto://` ref, a mention link, or
 * a document's embed. Its label is the link's, else the href itself. A web link or plain text is not one.
 */
export const padCardSourceOfText = (text: string): PadCardSource | undefined => {
  const link = parsePreviewLink(text);
  if (link === undefined) return undefined;
  // A blank label, "[ ](junto://...)", falls back to the href: a card's label is never empty.
  return { href: link.href, label: cardLabel(link.label?.replace(/^@/u, "") ?? "") || cardLabel(link.href) };
};

/** A drag that carries text: it may be a Junto link, read only on drop. */
export const dataTransferHasText = (data: DataTransfer | null | undefined): boolean =>
  data != null && (data.types.includes("text/plain") || data.types.includes("text/uri-list"));

/**
 * The card a drop makes: its plain text first, which keeps a link's label, then its first uri.
 * Undefined when neither names a Junto thing.
 */
export const padCardSourceOfTransfer = (data: DataTransfer | null | undefined): PadCardSource | undefined => {
  if (data == null) return undefined;
  const uri = data.getData("text/uri-list").split(/\r?\n/u).find((line) => line !== "" && !line.startsWith("#")) ?? "";
  return padCardSourceOfText(data.getData("text/plain")) ?? padCardSourceOfText(uri);
};

/**
 * An @ pick: the thing it names on this canvas, under the name the list showed. Undefined when
 * the canvas name cannot make a link (no canvas yet).
 */
export const padCardSourceOfPick = (pick: { readonly ref: MentionRef; readonly label: string }, canvasName: string): PadCardSource | undefined => {
  if (!isCanonicalCanvasName(canvasName)) return undefined;
  const href = mentionHref(pick.ref, canvasName);
  return { href, label: cardLabel(pick.label.replace(/^@/u, "")) || cardLabel(href) };
};

/**
 * The card a source makes on the pad, centred where it was dropped or picked, at the default card
 * box and on top of every shape: one shape upsert, so it lands as one ruled edit like any shape.
 */
export const padCardFor = (
  source: PadCardSource,
  at: PadPoint,
  pad: Pick<Pad, "shapes">,
  mint?: () => string,
): { readonly shape: PadShape; readonly patch: PadPatch } => {
  const { width: w, height: h } = PREVIEW_CARD_BOX;
  const shape: PadShape = {
    id: newPadElementId("card", mint),
    type: "card",
    x: Math.round(at.x - w / 2),
    y: Math.round(at.y - h / 2),
    w,
    h,
    z: nextLayerZ(pad.shapes),
    href: source.href,
    label: source.label,
  };
  return { shape, patch: { op: "upsert", layer: "shape", shape } };
};
