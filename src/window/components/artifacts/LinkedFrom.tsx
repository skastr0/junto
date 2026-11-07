import { Link2 } from "lucide-react";
import type { ArtifactType } from "@shared/artifact";
import type { MentionRef } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import { readableLine, useBodyLinks, type ArtifactTarget, type BodyLink } from "../../lib/linked-from";
import { useMentionedIn } from "../../lib/mentioned-in";
import { openMention } from "../../lib/mention-open";
import { useCanvas } from "../../lib/use-model";
import { agoLabel } from "../tasks/tasks-pane-model";
import { placeOf } from "../threads/MentionedIn";
import { mentionMark } from "../ui/ResourceChip";
import { Button, Eyebrow, ResourceChip } from "../ui";
import "../threads/mentioned-in.css";
import "./linked-from.css";

type Row =
  | { readonly kind: "body"; readonly key: string; readonly at: number; readonly link: BodyLink }
  | { readonly kind: "post"; readonly key: string; readonly at: number; readonly place: MentionRef; readonly meta: string };

/** What links to an artifact, read once for the rail's list and its collapsed edge. */
export type LinkedFromRead = {
  readonly rows: ReadonlyArray<Row>;
  /** Mail and comments are held further back. */
  readonly more: boolean;
  readonly loadMore: () => void;
};

/** How many places link the artifact, as the edge says it: "3", or "20+" while more are held back. */
export const linkedFromCount = (read: LinkedFromRead): string | undefined =>
  read.rows.length === 0 ? undefined : read.more ? `${String(read.rows.length)}+` : String(read.rows.length);

/** Body links and mail and comments that name the artifact, newest first; its own body left out. */
export const useLinkedFrom = (canvasName: string, target: ArtifactTarget, now: number): LinkedFromRead => {
  const ref: MentionRef = { kind: "artifact", nodeId: target.nodeId, artifactId: target.artifactId };
  const bodies = useBodyLinks(canvasName, target);
  const posts = useMentionedIn(canvasName, ref);
  const rows: Row[] = [];
  for (const link of bodies.links) {
    // A link from the artifact's own body is not a place to go.
    if (link.source.nodeId === target.nodeId && link.source.artifactId === target.artifactId) continue;
    rows.push({ kind: "body", key: `body:${link.source.nodeId}:${link.source.artifactId}`, at: link.at, link });
  }
  for (const entry of posts.entries) {
    const place = placeOf(entry);
    if (place === undefined) continue;
    // The operator reads their own posts as theirs, whatever name main gives them.
    const who = entry.author.kind === "operator" ? "you" : entry.author.name;
    const meta = `${entry.subject === undefined ? "mail" : "comment"} by ${who}, ${agoLabel(entry.at, now)}`;
    rows.push({ kind: "post", key: `post:${entry.messageId}`, at: entry.at, place, meta });
  }
  rows.sort((a, b) => b.at - a.at);
  return { rows, more: posts.more, loadMore: posts.loadMore };
};

type ListProps = {
  readonly canvasName: string;
  readonly now: number;
  /** A task's or an artifact's title for its chip; absent, the chip names its node. */
  readonly nameOf?: (place: MentionRef) => string | undefined;
  /** An artifact's type, for its chip's glyph. */
  readonly artifactTypeOf?: (place: MentionRef) => ArtifactType | undefined;
  /** An artifact's title now, for a `[[ ]]` link quoted in a body's line. */
  readonly artifactTitleOf?: (target: ArtifactTarget) => string | undefined;
  /** Opening a place leaves where the list is shown first. */
  readonly beforeOpen?: () => void;
};

/**
 * What links to an artifact (0.11 artifact links, L4), newest first: other
 * artifacts whose text links it, with the line the link sits in, and mail
 * and comments that mention it. Each row opens its place.
 */
export function LinkedFrom({ target, ...props }: ListProps & { readonly target: ArtifactTarget }) {
  return <LinkedFromList read={useLinkedFrom(props.canvasName, target, props.now)} {...props} />;
}

/** The list for a read already held, as the Artifacts rail shares one with its edge. */
export function LinkedFromList({ read, canvasName, now, nameOf, artifactTypeOf, artifactTitleOf, beforeOpen }: ListProps & { readonly read: LinkedFromRead }) {
  const nodes = useCanvas(canvasName).nodes;
  const { rows } = read;
  if (rows.length === 0) return null;

  const open = (place: MentionRef): void => {
    beforeOpen?.();
    openMention(place);
  };

  return (
    <section className="mentioned-in" aria-label="Linked from" data-testid="linked-from">
      <header className="mentioned-in__head">
        <Link2 size={13} aria-hidden />
        <Eyebrow tone="steel">Linked from, {linkedFromCount(read)}</Eyebrow>
      </header>
      <ul className="mentioned-in__list">
        {rows.map((row) => {
          if (row.kind === "body") {
            const { link } = row;
            const line = readableLine(link.line, artifactTitleOf);
            const place: MentionRef = { kind: "artifact", nodeId: link.source.nodeId, artifactId: link.source.artifactId };
            return (
              <li key={row.key} className="linked-from__row" data-testid="linked-from-row" data-kind="body">
                <span className="linked-from__head">
                  <ResourceChip
                    kind="artifact"
                    artifactType={link.type}
                    label={link.title}
                    missing={!nodes.has(link.source.nodeId)}
                    onOpen={() => open(place)}
                  />
                  <span className="linked-from__meta">in its text, {agoLabel(link.at, now)}</span>
                </span>
                {line === "" ? null : <span className="linked-from__line">{line}</span>}
              </li>
            );
          }
          const node = nodes.get(row.place.nodeId);
          const label = nameOf?.(row.place) ?? (node === undefined ? row.place.nodeId : titleOf(node));
          return (
            <li key={row.key} className="linked-from__row" data-testid="linked-from-row" data-kind="post">
              <span className="linked-from__head">
                <ResourceChip
                  {...mentionMark(row.place)}
                  {...(row.place.kind === "artifact" ? { artifactType: artifactTypeOf?.(row.place) } : {})}
                  label={label}
                  missing={node === undefined}
                  onOpen={() => open(row.place)}
                />
                <span className="linked-from__meta">{row.meta}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {read.more ? (
        <Button size="xs" variant="subtle" onClick={read.loadMore} data-testid="linked-from-more">
          Show earlier
        </Button>
      ) : null}
    </section>
  );
}
