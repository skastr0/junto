import { Link2 } from "lucide-react";
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

/**
 * What links to an artifact (0.11 artifact links, L4), newest first: other
 * artifacts whose text links it, with the line the link sits in, and mail
 * and comments that mention it. Each row opens its place.
 */
export function LinkedFrom({
  canvasName,
  target,
  now,
  nameOf,
  beforeOpen,
}: {
  readonly canvasName: string;
  readonly target: ArtifactTarget;
  readonly now: number;
  /** A task's title for its chip; absent, the chip names its node. */
  readonly nameOf?: (place: MentionRef) => string | undefined;
  /** Opening a place leaves where the list is shown first. */
  readonly beforeOpen?: () => void;
}) {
  const ref: MentionRef = { kind: "artifact", nodeId: target.nodeId, artifactId: target.artifactId };
  const bodies = useBodyLinks(canvasName, target);
  const posts = useMentionedIn(canvasName, ref);
  const nodes = useCanvas(canvasName).nodes;

  const rows: Row[] = [];
  for (const link of bodies.links) {
    // A link from the artifact's own body is not a place to go.
    if (link.source.nodeId === target.nodeId && link.source.artifactId === target.artifactId) continue;
    rows.push({ kind: "body", key: `body:${link.source.nodeId}:${link.source.artifactId}`, at: link.at, link });
  }
  for (const entry of posts.entries) {
    const place = placeOf(entry);
    if (place === undefined) continue;
    const meta = `${entry.subject === undefined ? "mail" : "comment"} by ${entry.author.name}, ${agoLabel(entry.at, now)}`;
    rows.push({ kind: "post", key: `post:${entry.messageId}`, at: entry.at, place, meta });
  }
  rows.sort((a, b) => b.at - a.at);
  if (rows.length === 0) return null;

  const open = (place: MentionRef): void => {
    beforeOpen?.();
    openMention(place);
  };

  return (
    <section className="mentioned-in" aria-label="Linked from" data-testid="linked-from">
      <header className="mentioned-in__head">
        <Link2 size={13} aria-hidden />
        <Eyebrow tone="steel">Linked from, {posts.more ? `${rows.length}+` : rows.length}</Eyebrow>
      </header>
      <ul className="mentioned-in__list">
        {rows.map((row) => {
          if (row.kind === "body") {
            const { link } = row;
            const place: MentionRef = { kind: "artifact", nodeId: link.source.nodeId, artifactId: link.source.artifactId };
            return (
              <li key={row.key} className="linked-from__row" data-testid="linked-from-row" data-kind="body">
                <span className="mentioned-in__row">
                  <ResourceChip
                    kind="artifact"
                    artifactType={link.type}
                    label={link.title}
                    missing={!nodes.has(link.source.nodeId)}
                    onOpen={() => open(place)}
                  />
                  <span className="mentioned-in__meta">in its text, {agoLabel(link.at, now)}</span>
                </span>
                {readableLine(link.line) === "" ? null : <span className="linked-from__line">{readableLine(link.line)}</span>}
              </li>
            );
          }
          const node = nodes.get(row.place.nodeId);
          const label = nameOf?.(row.place) ?? (node === undefined ? row.place.nodeId : titleOf(node));
          return (
            <li key={row.key} className="mentioned-in__row" data-testid="linked-from-row" data-kind="post">
              <ResourceChip {...mentionMark(row.place)} label={label} missing={node === undefined} onOpen={() => open(row.place)} />
              <span className="mentioned-in__meta">{row.meta}</span>
            </li>
          );
        })}
      </ul>
      {posts.more ? (
        <Button size="xs" variant="subtle" onClick={posts.loadMore} data-testid="linked-from-more">
          Show earlier
        </Button>
      ) : null}
    </section>
  );
}
