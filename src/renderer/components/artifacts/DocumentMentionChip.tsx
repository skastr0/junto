import type { MouseEvent } from "react";
import { ARTIFACT_GONE_LINE, artifactLinkStateOf, artifactLinkTitle } from "@shared/artifact-link";
import { matchMention, parseMentionHref, type MentionOf } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import { parseNodeRef } from "@shared/node-ref";
import type { NodeId } from "@shared/physics/schema";
import { useNodeArtifactsRead } from "../../lib/artifacts-source";
import { mentionChipOf, openMention } from "../../lib/mention-open";
import type { ArtifactType } from "../../lib/resource-visuals";
import { ResourceChip, mentionMark } from "../ui/ResourceChip";

/** A press on the chip must leave the caret, the selection and the keyboard where they are. */
const keepEditorFocus = (event: MouseEvent): void => event.preventDefault();

/** The canvas a link was written on: where to read an artifact's type when the host does not say. */
const canvasOfHref = (href: string): string | undefined => {
  const node = parseNodeRef(href.split("&item=")[0] ?? href);
  return node.ok ? node.value.canvasName : undefined;
};

type ChipProps = {
  readonly mark: ReturnType<typeof mentionMark> | { readonly kind: NonNullable<ReturnType<typeof mentionChipOf>["kind"]> };
  readonly label: string;
  readonly number: number | undefined;
  readonly open: (() => void) | undefined;
  readonly artifactType?: ArtifactType | undefined;
  readonly archived?: boolean;
  /** A missing chip's press: it says the artifact is gone. */
  readonly gone?: (() => void) | undefined;
};

function Chip({ mark, label, number, open, artifactType, archived = false, gone }: ChipProps) {
  const press = open ?? gone;
  return (
    <ResourceChip
      {...mark}
      {...(artifactType === undefined ? {} : { artifactType })}
      label={label}
      number={number}
      archived={archived}
      missing={open === undefined}
      {...(open === undefined ? {} : { onOpen: open })}
      {...(gone === undefined || open !== undefined ? {} : { onMissing: gone, title: ARTIFACT_GONE_LINE })}
      {...(press === undefined ? {} : { tabIndex: -1, onMouseDown: keepEditorFocus })}
      data-testid="document-mention-chip"
    />
  );
}

/**
 * An artifact chip says what the link names now (`artifactLinkStateOf`, one
 * state for every surface): its title and type's glyph, live; dimmed and
 * named archived, still opening; or, once its node is read and does not hold
 * it, "Missing artifact", whose press says it is gone. Until the node is
 * read, the words the link was written with and the generic mark.
 */
function ArtifactChip({
  refOf,
  canvasName,
  written,
  onGone,
  ...chip
}: ChipProps & {
  readonly refOf: MentionOf<"artifact">;
  readonly canvasName: string;
  readonly written: string;
  readonly onGone: (() => void) | undefined;
}) {
  const heads = useNodeArtifactsRead(canvasName, refOf.nodeId);
  const link = artifactLinkStateOf(refOf.artifactId, heads?.map((head) => head.artifact), written);
  switch (link.state) {
    case "unread":
      return <Chip {...chip} label={link.words} />;
    case "live":
      return <Chip {...chip} label={link.words} artifactType={link.type} />;
    case "archived":
      return <Chip {...chip} label={link.words} artifactType={link.type} archived />;
    case "missing":
      return <Chip {...chip} label={link.words} open={undefined} gone={onGone} />;
  }
}

/**
 * A mention link in a live document, drawn as the chip every other surface
 * draws (03 section 3): `[@product-feed](junto://...)` off the caret is the
 * seat's chip, and a click opens what it names. The canvas says what the
 * node is now, so a seat, task or artifact that is gone is drawn unavailable
 * and does not open. A link that is not a mention stays its words.
 *
 * It sits inside the editor's text, so it claims nothing: no focus stop
 * (Tab moves through the document, not its chips) and a press neither moves
 * the caret nor takes the keyboard.
 */
export function DocumentMentionChip({
  href,
  label,
  nodeKindOf,
  canvasName,
  onGone,
}: {
  readonly href: string;
  /** The link's text as written, `@name` or `#42 title`. */
  readonly label: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  /** Where the text lives, to read an artifact's type; without it, the canvas the link was written on. */
  readonly canvasName?: string;
  /** Say that a missing artifact is gone, when its chip is pressed. */
  readonly onGone?: (() => void) | undefined;
}) {
  const target = parseMentionHref(href);
  if (target === undefined) return <span>{label}</span>;
  // A `[[ ]]` link draws as its title, without the brackets it is typed with.
  const linkTitle = artifactLinkTitle(label);
  const { ref, kind, label: shown, number } = mentionChipOf({ target, label: linkTitle ?? label }, nodeKindOf);
  // A gone seat or page: its link cannot say which, so it is its words, struck.
  if (kind === undefined) {
    return (
      <del data-testid="document-mention-chip" data-missing="true">
        {shown}
      </del>
    );
  }
  const chip: ChipProps = { mark: ref === undefined ? { kind } : mentionMark(ref), label: shown, number, open: ref === undefined ? undefined : () => openMention(ref) };
  const canvas = canvasName ?? canvasOfHref(href);
  if (ref === undefined || canvas === undefined) return <Chip {...chip} />;
  return matchMention(ref, {
    seat: () => <Chip {...chip} />,
    page: () => <Chip {...chip} />,
    task: () => <Chip {...chip} />,
    artifact: (artifact) => <ArtifactChip {...chip} refOf={artifact} canvasName={canvas} written={label} onGone={onGone} />,
  });
}
