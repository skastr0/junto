import { AtSign } from "lucide-react";
import type { MentionRef } from "@shared/mention";
import type { MentionedIn as MentionedInEntry } from "@shared/mention-ipc";
import type { ResourceSubject } from "@shared/thread-subject";
import { titleOf } from "@shared/model/title";
import { mentionMark } from "../ui/ResourceChip";
import { useMentionedIn } from "../../lib/mentioned-in";
import { openMention } from "../../lib/mention-open";
import { useCanvas } from "../../lib/use-model";
import { agoLabel } from "../tasks/tasks-pane-model";
import { Button, Eyebrow, ResourceChip } from "../ui";
import "./mentioned-in.css";

/** The place a backlink was written, as the thing it opens: the resource commented on, or the seat mailed. */
const placeOf = (entry: MentionedInEntry): MentionRef => {
  const subject: ResourceSubject | undefined = entry.subject;
  if (subject === undefined) return { kind: "seat", nodeId: entry.mailbox };
  switch (subject.kind) {
    case "task":
      return { kind: "task", nodeId: subject.nodeId, taskId: subject.taskId };
    case "artifact":
      return { kind: "artifact", nodeId: subject.nodeId, artifactId: subject.artifactId };
    case "page":
      return { kind: "page", nodeId: subject.nodeId };
  }
};

/**
 * Where a seat, task, artifact or page is mentioned (plan 0.10, 03 section
 * 3: "Resources list where they were mentioned"), newest first: the place as
 * a chip that opens it, who wrote it, and when. A comment's place is the
 * resource it is on; mail's is the seat it went to.
 */
export function MentionedIn({
  canvasName,
  target,
  now,
  nameOf,
  beforeOpen,
}: {
  readonly canvasName: string;
  readonly target: MentionRef;
  readonly now: number;
  /** A task's or artifact's title for its chip; absent, the chip names its node. */
  readonly nameOf?: (place: MentionRef) => string | undefined;
  /** Opening a place leaves where the list is shown first. */
  readonly beforeOpen?: () => void;
}) {
  const { entries, loaded, more, loadMore } = useMentionedIn(canvasName, target);
  const nodes = useCanvas(canvasName).nodes;
  if (!loaded || entries.length === 0) return null;
  return (
    <section className="mentioned-in" aria-label="Mentioned in" data-testid="mentioned-in">
      <header className="mentioned-in__head">
        <AtSign size={13} aria-hidden />
        <Eyebrow tone="steel">Mentioned in, {more ? `${entries.length}+` : entries.length}</Eyebrow>
      </header>
      <ul className="mentioned-in__list">
        {entries.map((entry) => {
          const place = placeOf(entry);
          const node = nodes.get(place.nodeId);
          const label = nameOf?.(place) ?? (node === undefined ? place.nodeId : titleOf(node));
          return (
            <li key={entry.messageId} className="mentioned-in__row" data-testid="mentioned-in-row" data-message={entry.messageId}>
              <ResourceChip
                {...mentionMark(place)}
                label={label}
                missing={node === undefined}
                onOpen={() => {
                  beforeOpen?.();
                  openMention(place);
                }}
              />
              <span className="mentioned-in__meta">
                {entry.subject === undefined ? "mail" : "comment"} by {entry.author.name}, {agoLabel(entry.at, now)}
              </span>
            </li>
          );
        })}
      </ul>
      {more ? (
        <Button size="xs" variant="subtle" onClick={loadMore} data-testid="mentioned-in-more">
          Show earlier
        </Button>
      ) : null}
    </section>
  );
}
