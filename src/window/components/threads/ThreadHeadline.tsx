import { previewText } from "../../lib/seat-threads";
import { threadHeadline } from "../../lib/thread-text";
import "./seat-threads.css";

/**
 * A thread's line as it is drawn: its words, with each long id as the token
 * whose whole value stays in the document (the stylesheet cuts what the eye
 * sees). A row is a button whose name is this text, so nothing here may cut an
 * id into a string. The one way a thread says a message in a line, wherever
 * the line is: a row, a chat's head, the signal a reply answers.
 */
/** The same line as plain words, for a name that must be a string: every id whole. */
export const threadHeadlineText = (text: string, known: ReadonlyArray<string>): string =>
  threadHeadline(previewText(text), known)
    .map((segment) => segment.id ?? segment.text)
    .join("");

export function ThreadHeadline({ text, known }: { readonly text: string; readonly known: ReadonlyArray<string> }) {
  return (
    <>
      {threadHeadline(previewText(text), known).map((segment, index) =>
        segment.id === undefined ? (
          segment.text
        ) : (
          <span key={`${segment.id}-${String(index)}`} className="seat-threads__id">
            {segment.id}
          </span>
        ),
      )}
    </>
  );
}
