import type { ComponentPropsWithRef, CSSProperties } from "react";
import { File, FileText, Globe, Link2, ListTodo, Package, PenLine, Table, type LucideIcon } from "lucide-react";
import {
  ARTIFACT_TYPE_NOUN,
  RESOURCE_KIND_VISUAL,
  markColor,
  type ArtifactType,
  type GlyphKind,
  type ResourceKind,
} from "../../lib/resource-visuals";
import type { MentionRef } from "@shared/mention";
import { AgentPortrait } from "../AgentPortrait";
import "./resource-chip.css";

const GLYPH: Readonly<Record<GlyphKind, LucideIcon>> = {
  task: ListTodo,
  artifact: Package,
  page: Globe,
};

const ARTIFACT_GLYPH: Readonly<Record<ArtifactType, LucideIcon>> = {
  link: Link2,
  document: FileText,
  pad: PenLine,
  sheet: Table,
  file: File,
};

const glyphFor = (kind: GlyphKind, artifactType?: ArtifactType): LucideIcon =>
  kind === "artifact" && artifactType ? ARTIFACT_GLYPH[artifactType] : GLYPH[kind];

/** The portrait a seat wears in a chip or a list: 14px, round, no badge, no mood. */
export const SEAT_MARK_SIZE = 14;

/**
 * What a mark names: a seat by its portrait's identity, anything else by its
 * kind. A seat's identity is its node id; a peer or a removed seat, which has
 * none here, is drawn from its name, so it still wears a portrait.
 */
export type ResourceMarkOf =
  | { readonly kind: "seat"; readonly seat: string; readonly artifactType?: never }
  | { readonly kind: GlyphKind; readonly seat?: never; readonly artifactType?: ArtifactType };

function ChipGlyph({ kind, artifactType }: { readonly kind: GlyphKind; readonly artifactType: ArtifactType | undefined }) {
  const Glyph = glyphFor(kind, artifactType);
  return <Glyph size={11} aria-hidden className="resource-chip__glyph" />;
}

/** A mention's mark: a seat mention wears its seat's portrait. */
export const mentionMark = (ref: MentionRef): ResourceMarkOf =>
  ref.kind === "seat" ? { kind: "seat", seat: ref.nodeId } : { kind: ref.kind };

function SeatMark({ seat, size }: { readonly seat: string; readonly size: number }) {
  return (
    <span className="resource-chip__portrait" data-testid="seat-portrait-mark">
      <AgentPortrait identity={seat} size={size} frame="round" outline={false} badge={false} />
    </span>
  );
}

/**
 * ResourceGlyphMark: the kind's mark, for a place that names a resource
 * without a whole chip (a list row, an option): a seat's portrait, or the
 * kind's glyph in the kind's hue. The same marks as ResourceChip, so a kind
 * never wears two.
 */
export function ResourceGlyphMark(props: ResourceMarkOf & { readonly size?: number }) {
  if (props.kind === "seat") return <SeatMark seat={props.seat} size={props.size ?? SEAT_MARK_SIZE} />;
  const Glyph = glyphFor(props.kind, props.artifactType);
  return <Glyph size={props.size ?? 11} aria-hidden style={{ color: markColor(RESOURCE_KIND_VISUAL[props.kind].tone), flex: "none" }} />;
}

/**
 * ResourceChip: a mention, drawn. One chip for a seat, a task, an artifact or
 * a page, wherever one is named: a composer, a comment, a feed attachment, an
 * automation target, a backlink. A neutral filled chip with the kind's mark;
 * the words stay ink (a hue is a mark, never a word).
 *
 *   seat       @name                      the seat's portrait, never a glyph
 *   task       #42 title                  green list (number first, tabular)
 *   artifact   title                      violet, the glyph of its type
 *   page       name                       indigo globe
 *
 * With `onOpen` the chip is one button that opens the thing. Without it the
 * chip only names it: a plain span, no hover, no focus stop, text selectable
 * (the shape for a chip inside a composer, whose own caret rules apply).
 *
 * States, all drawn without colour alone:
 *  - `pending`: the thing is a queued command the editing machine has not
 *    ruled yet (02). Dashed edge, no fill. Spoken as "queued".
 *  - `missing`: out of reach or gone. Struck through, dim, never openable; a
 *    seat's portrait stays, dimmed.
 *
 * `label` is the display text only; the link form `[@name](junto://...)`
 * belongs to the mention contract (03) and never reaches this component.
 */
export function ResourceChip(
  props: {
    readonly kind: ResourceKind;
    /** A seat's portrait identity: its node id. Absent, the seat is drawn from its name (a peer, a removed seat). */
    readonly seat?: string | undefined;
    /** An artifact's type picks its glyph. Ignored for the other kinds. */
    readonly artifactType?: ArtifactType | undefined;
    /** The name or title, without `@` or `#`: the chip adds what its kind needs. */
    readonly label: string;
    /** A task's per-canvas number (04). Ignored for the other kinds. */
    readonly number?: number | undefined;
    readonly pending?: boolean;
    /** Archived: still real and still opens, drawn dimmed and named archived. */
    readonly archived?: boolean;
    /** Gone or out of reach: inert, `onOpen` ignored. */
    readonly missing?: boolean;
    readonly onOpen?: () => void;
    /** A missing chip that says why when pressed, rather than staying inert. */
    readonly onMissing?: () => void;
  } & Omit<ComponentPropsWithRef<"span">, "children" | "className" | "onClick" | "role">,
) {
  const { kind, seat, artifactType, label, number, pending = false, archived = false, missing = false, onOpen, onMissing, ...rest } = props;
  const visual = RESOURCE_KIND_VISUAL[kind];
  const noun = kind === "artifact" && artifactType ? ARTIFACT_TYPE_NOUN[artifactType] : visual.noun;
  const state = missing ? ", unavailable" : pending ? ", queued" : archived ? ", archived" : "";
  const numbered = kind === "task" && number !== undefined;
  // A task's "#42" is drawn in the chip's own words, so it is read where it is
  // drawn: the number needs no second saying, and the words after the label owe
  // only the state. A task with no number keeps its kind.
  const suffix = numbered ? state : `, ${noun}${state}`;
  const content = (
    <>
      {kind === "seat" ? <SeatMark seat={seat ?? label} size={SEAT_MARK_SIZE} /> : <ChipGlyph kind={kind} artifactType={artifactType} />}
      {numbered ? <span className="resource-chip__number">#{number}</span> : null}
      <span className="resource-chip__label">{kind === "seat" ? `@${label}` : label}</span>
      {suffix === "" ? null : <span className="sr-only">{suffix}</span>}
    </>
  );
  const common = {
    className: "resource-chip",
    "data-kind": kind,
    "data-pending": pending ? "true" : undefined,
    "data-missing": missing ? "true" : undefined,
    "data-archived": archived && !missing ? "true" : undefined,
    // A seat wears its portrait, not a hue.
    ...(kind === "seat" ? {} : { style: { "--mark": markColor(visual.tone) } as CSSProperties }),
  } as const;
  const press = missing ? onMissing : onOpen;
  if (press) {
    const { ref: _ref, ...button } = rest;
    return (
      <button type="button" {...(button as ComponentPropsWithRef<"button">)} {...common} onClick={press}>
        {content}
      </button>
    );
  }
  return (
    <span {...rest} {...common}>
      {content}
    </span>
  );
}
