import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { ArtifactVersion, DocumentBody, TextPatch } from "@shared/artifact";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { Button } from "../ui";
import { textSplice } from "./artifacts-pane-model";

/** How long typing rests before it is sent as one version. */
const SAVE_REST_MS = 800;

type View = "write" | "split" | "read";

/**
 * A document artifact: markdown typed on the left, read on the right. Typing
 * is sent as one splice per rest against the version it started from; the
 * draft is never thrown away by a refusal, so a stale write can be read,
 * then sent again on the new head.
 */
export function DocumentEditor({
  body,
  version,
  readOnly = false,
  onPatch,
  onCommentText,
}: {
  readonly body: DocumentBody;
  readonly version: ArtifactVersion;
  readonly readOnly?: boolean;
  /** Sends patches written against `baseVersion`; resolves to a refusal line, or null when applied. */
  readonly onPatch: (baseVersion: ArtifactVersion, patches: ReadonlyArray<TextPatch>) => Promise<string | null>;
  readonly onCommentText?: (quote: string, offset: number) => void;
}) {
  const [draft, setDraft] = useState(body.markdown);
  const [view, setView] = useState<View>("split");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ readonly quote: string; readonly offset: number } | null>(null);
  /** The head the draft was last in step with: what a splice is computed from. */
  const synced = useRef({ markdown: body.markdown, version });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new head that is not our own write: take it when the draft has no unsent change.
  useEffect(() => {
    if (version === synced.current.version) return;
    const unsent = draft !== synced.current.markdown;
    synced.current = { markdown: body.markdown, version };
    if (!unsent) setDraft(body.markdown);
  }, [version, body.markdown]);

  const send = async (text: string): Promise<void> => {
    const patch = textSplice(synced.current.markdown, text);
    if (patch === null) return;
    const base = synced.current.version;
    const refused = await onPatch(base, [patch]);
    setRefusal(refused);
    if (refused === null) synced.current = { markdown: text, version: (base + 1) as ArtifactVersion };
  };

  const type = (text: string): void => {
    setDraft(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(text), SAVE_REST_MS);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const select = (target: HTMLTextAreaElement): void => {
    const quote = target.value.slice(target.selectionStart, target.selectionEnd);
    setSelection(quote.trim().length > 0 ? { quote, offset: target.selectionStart } : null);
  };

  const takeHead = (): void => {
    synced.current = { markdown: body.markdown, version };
    setDraft(body.markdown);
    setRefusal(null);
  };

  return (
    <div className="artifact-document" data-view={view}>
      <div className="artifact-document__bar" role="toolbar" aria-label="Document view">
        {(["write", "split", "read"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={view === option ? "chrome" : "subtle"}
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "write" ? "Write" : option === "split" ? "Split" : "Read"}
          </Button>
        ))}
        <span className="artifact-document__spacer" />
        {selection && onCommentText ? (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              onCommentText(selection.quote, selection.offset);
              setSelection(null);
            }}
          >
            <MessageSquarePlus size={13} aria-hidden />
            Comment on selection
          </Button>
        ) : null}
      </div>
      {refusal ? (
        <div className="artifact-document__refusal" role="status">
          <span>{refusal}</span>
          <Button size="sm" variant="subtle" onClick={() => void send(draft)}>
            Send again
          </Button>
          <Button size="sm" variant="subtle" onClick={takeHead}>
            Take theirs
          </Button>
        </div>
      ) : null}
      <div className="artifact-document__panes">
        {view !== "read" ? (
          <textarea
            className="artifact-document__source"
            aria-label="Markdown"
            spellCheck
            readOnly={readOnly}
            value={draft}
            onChange={(event) => type(event.target.value)}
            onSelect={(event) => select(event.currentTarget)}
            onBlur={() => {
              if (timer.current !== null) clearTimeout(timer.current);
              void send(draft);
            }}
          />
        ) : null}
        {view !== "write" ? (
          <div className="artifact-document__read">
            {draft.trim().length > 0 ? (
              <ArtifactMarkdown source={draft} />
            ) : (
              <p className="artifact-document__blank">Nothing written yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
