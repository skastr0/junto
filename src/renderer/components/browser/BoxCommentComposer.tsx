import { useState } from "react";
import type { BrowserBoxDraft } from "@shared/browser-chrome";
import { pngDataUrl } from "../../lib/png-data-url";
import { Button, Textarea } from "../ui";
import { claimFocusOnMount } from "../../lib/focus-ownership";

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
  pending = false,
  onPost,
  onDiscard,
}: {
  readonly draft: BrowserBoxDraft;
  readonly pending?: boolean;
  readonly onPost: (text: string) => void;
  readonly onDiscard: () => void;
}) {
  const [text, setText] = useState("");
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
          This image goes with your comment, from {hostOf(draft.url)}. Nothing else of the page does.
        </figcaption>
      </figure>
      <Textarea
        ref={claimFocusOnMount}
        dense
        aria-label="Comment"
        placeholder="What about this area?"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
