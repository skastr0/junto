import type { MouseEvent } from "react";
import { artifactLinkTitle } from "@shared/artifact-link";
import { matchMention, parseMentionHref, type MentionOf } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import { parseNodeRef } from "@shared/node-ref";
import type { NodeId } from "@shared/physics/schema";
import { useNodeArtifacts } from "../../lib/artifacts-source";
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
};

function Chip({ mark, label, number, open, artifactType }: ChipProps) {
  return (
    <ResourceChip
      {...mark}
      {...(artifactType === undefined ? {} : { artifactType })}
      label={label}
      number={number}
      missing={open === undefined}
      {...(open === undefined ? {} : { onOpen: open, tabIndex: -1, onMouseDown: keepEditorFocus })}
      data-testid="document-mention-chip"
    />
  );
}

/**
 * An artifact wears its type's glyph: a document its page, a sheet its grid. Until the node is read, the generic mark.
 * A `[[ ]]` link says the artifact's title now, so a rename never leaves it stale; until the node is read, the title it was written with.
 */
function ArtifactChip({
  refOf,
  canvasName,
  linked,
  ...chip
}: ChipProps & { readonly refOf: MentionOf<"artifact">; readonly canvasName: string; readonly linked: boolean }) {
  const heads = useNodeArtifacts(canvasName, refOf.nodeId);
  const artifact = heads.find((head) => head.artifact.artifactId === refOf.artifactId)?.artifact;
  return <Chip {...chip} label={linked && artifact !== undefined ? artifact.title : chip.label} artifactType={artifact?.type} />;
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
}: {
  readonly href: string;
  /** The link's text as written, `@name` or `#42 title`. */
  readonly label: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  /** Where the text lives, to read an artifact's type; without it, the canvas the link was written on. */
  readonly canvasName?: string;
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
    artifact: (artifact) => <ArtifactChip {...chip} refOf={artifact} canvasName={canvas} linked={linkTitle !== undefined} />,
  });
}
