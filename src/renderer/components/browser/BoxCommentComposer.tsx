import { useCallback, useState, type KeyboardEvent } from "react";
import type { BrowserBoxDraft } from "@shared/browser-chrome";
import { asNodeId } from "@shared/model";
import { pngDataUrl } from "../../lib/png-data-url";
import { Button } from "../ui";
import { MentionCombobox } from "../ui/MentionCombobox";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { useSeatsInReach } from "../../lib/mention-sources";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The composer for a comment on an area of the page. It shows the shot the
 * comment will carry before anything is posted: main staged exactly these
 * bytes and posting names them, so what crosses machines is what the operator
 * saw and chose. Nothing else of the page goes with it but its address.
 */
export function BoxCommentComposer({
  draft,
  canvasName,
  nodeId,
  pending = false,
  onPost,
  onDiscard,
}: {
  readonly draft: BrowserBoxDraft;
  /** The canvas and the page node: `@` names a seat in the page's reach, the only seats a comment on it may mention. */
  readonly canvasName: string;
  readonly nodeId: string;
  readonly pending?: boolean;
  readonly onPost: (text: string) => void;
  readonly onDiscard: () => void;
}) {
  const [text, setText] = useState("");
  const seats = useSeatsInReach(canvasName, asNodeId(nodeId));
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    claimFocusOnMount(element);
  }, []);
  const ready = text.trim().length > 0 && !pending;
  return (
    <form
      className="box-composer"
      aria-label="Comment on an area"
      data-testid="box-comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onPost(text.trim());
      }}
    >
      <figure className="box-composer__shot">
        <img src={pngDataUrl(draft.png)} alt={`The area you marked on ${hostOf(draft.url)}`} width={draft.width} height={draft.height} />
        <figcaption>
          This image and this address go with your comment: <span className="box-composer__url">{draft.url}</span>. Nothing else of the page does.
        </figcaption>
      </figure>
      <MentionCombobox
        fieldRef={setField}
        dense
        value={text}
        onValueChange={(next) => setText(next)}
        canvasName={canvasName}
        candidates={seats}
        listLabel={() => "Seats in reach of this page"}
        noun={{ one: "seat", other: "seats" }}
        placeholder="What about this area? @ names a seat in reach"
        aria-label="Comment"
        rows={3}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (ready) onPost(text.trim());
          }
        }}
      />
      <div className="box-composer__actions">
        <Button size="xs" variant="subtle" type="button" disabled={pending} onClick={onDiscard}>
          Discard
        </Button>
        <Button size="xs" variant="primary" type="submit" disabled={!ready}>
          Post comment
        </Button>
      </div>
    </form>
  );
}
