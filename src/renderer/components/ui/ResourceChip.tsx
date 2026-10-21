import type { ComponentPropsWithRef, CSSProperties } from "react";
import { Bot, File, FileText, Globe, Link2, ListTodo, Package, PenLine, Table, type LucideIcon } from "lucide-react";
import {
  ARTIFACT_TYPE_NOUN,
  RESOURCE_KIND_VISUAL,
  markColor,
  type ArtifactType,
  type ResourceGlyph,
  type ResourceKind,
} from "../../lib/resource-visuals";
import "./resource-chip.css";

const GLYPH: Readonly<Record<ResourceGlyph, LucideIcon>> = {
  seat: Bot,
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

const glyphFor = (kind: ResourceKind, artifactType?: ArtifactType): LucideIcon =>
  kind === "artifact" && artifactType ? ARTIFACT_GLYPH[artifactType] : GLYPH[RESOURCE_KIND_VISUAL[kind].glyph];

/**
 * ResourceGlyphMark: the kind's glyph in the kind's hue, for a place that
 * names a resource without a whole chip (a list row, an option). The same
 * glyph table as ResourceChip, so a kind never wears two marks.
 */
export function ResourceGlyphMark({
  kind,
  artifactType,
  size = 11,
}: {
  readonly kind: ResourceKind;
  readonly artifactType?: ArtifactType;
  readonly size?: number;
}) {
  const Glyph = glyphFor(kind, artifactType);
  return <Glyph size={size} aria-hidden style={{ color: markColor(RESOURCE_KIND_VISUAL[kind].tone), flex: "none" }} />;
}

/**
 * ResourceChip: a mention, drawn. One chip for a seat, a task, an artifact or
 * a page, wherever one is named: a composer, a comment, a feed attachment, an
 * automation target, a backlink. A neutral filled chip with the kind's glyph
 * in its hue; the words stay ink (a hue is a mark, never a word).
 *
 *   seat       @name                      amber robot
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
 *  - `missing`: out of reach or gone. Struck through, dim, never openable.
 *
 * `label` is the display text only; the link form `[@name](junto://...)`
 * belongs to the mention contract (03) and never reaches this component.
 */
export function ResourceChip({
  kind,
  label,
  number,
  artifactType,
  pending = false,
  missing = false,
  onOpen,
  ...rest
}: {
  readonly kind: ResourceKind;
  /** The name or title, without `@` or `#`: the chip adds what its kind needs. */
  readonly label: string;
  /** A task's per-canvas number (04). Ignored for the other kinds. */
  readonly number?: number;
  /** An artifact's type picks its glyph. Ignored for the other kinds. */
  readonly artifactType?: ArtifactType;
  readonly pending?: boolean;
  readonly missing?: boolean;
  readonly onOpen?: () => void;
} & Omit<ComponentPropsWithRef<"span">, "children" | "className" | "onClick" | "role">) {
  const visual = RESOURCE_KIND_VISUAL[kind];
  const Glyph = glyphFor(kind, artifactType);
  const noun = kind === "artifact" && artifactType ? ARTIFACT_TYPE_NOUN[artifactType] : visual.noun;
  const state = missing ? ", unavailable" : pending ? ", queued" : "";
  const content = (
    <>
      <Glyph size={11} aria-hidden className="resource-chip__glyph" />
      {kind === "task" && number !== undefined ? (
        <span className="resource-chip__number" aria-hidden>
          #{number}
        </span>
      ) : null}
      <span className="resource-chip__label">{kind === "seat" ? `@${label}` : label}</span>
      <span className="sr-only">{`, ${noun}${kind === "task" && number !== undefined ? ` ${number}` : ""}${state}`}</span>
    </>
  );
  const common = {
    className: "resource-chip",
    "data-kind": kind,
    "data-pending": pending ? "true" : undefined,
    "data-missing": missing ? "true" : undefined,
    style: { "--mark": markColor(visual.tone) } as CSSProperties,
  } as const;
  if (onOpen && !missing) {
    const { ref: _ref, ...button } = rest;
    return (
      <button type="button" {...(button as ComponentPropsWithRef<"button">)} {...common} onClick={onOpen}>
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
