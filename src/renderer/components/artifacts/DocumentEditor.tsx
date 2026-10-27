import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { ArtifactVersion, DocumentBody, TextPatch } from "@shared/artifact";
import type { TextAnchor } from "@shared/thread-subject";
import { Button } from "../ui";
import { textSplice } from "./artifacts-pane-model";
import {
  anchorsEffect,
  type DocumentAnchor,
  liveMarkdown,
  type LiveMarkdownHandlers,
  revealAnchorEffects,
} from "./live-markdown";

/** How long typing rests before it is sent as one version. */
const SAVE_REST_MS = 800;

/** Marks a change that came from a head, not from the operator's typing. */
const fromHead = Annotation.define<boolean>();

const editable = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

/**
 * A document artifact: one surface, always rendered, where the lines under
 * the caret show their markdown to edit in place. Typing is sent as one
 * splice per rest against the version it started from; the draft is never
 * thrown away by a refusal, so a stale write can be read, then sent again on
 * the new head.
 */
export function DocumentEditor({
  body,
  version,
  readOnly = false,
  onPatch,
  onCommentText,
  anchors,
  onAnchor,
  revealAnchor,
}: {
  readonly body: DocumentBody;
  readonly version: ArtifactVersion;
  readonly readOnly?: boolean;
  /** Sends patches written against `baseVersion`; resolves to a refusal line, or null when applied. */
  readonly onPatch: (baseVersion: ArtifactVersion, patches: ReadonlyArray<TextPatch>) => Promise<string | null>;
  /**
   * A selection to comment on, with the save to run before the comment posts:
   * main checks the quote against the saved document, so text still resting
   * in the draft is sent first. The save resolves to a refusal line, or null.
   */
  readonly onCommentText?: (quote: string, offset: number, save: () => Promise<string | null>) => void;
  /** Text-anchored threads, drawn as marks on their quotes; a quote no longer in the text draws nothing. */
  readonly anchors?: ReadonlyArray<{ readonly threadId: string; readonly anchor: TextAnchor; readonly count: number }>;
  /** A press on a thread's mark. */
  readonly onAnchor?: (threadId: string) => void;
  /** Scroll a quote into view and flash it; a new nonce asks again. */
  readonly revealAnchor?: { readonly anchor: TextAnchor; readonly nonce: number };
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ readonly quote: string; readonly offset: number } | null>(null);
  /** The head the draft was last in step with: what a splice is computed from. */
  const synced = useRef({ markdown: body.markdown, version });
  /** The newest head seen, which may be ahead of `synced` while the draft holds unsent text. */
  const head = useRef({ markdown: body.markdown, version });
  head.current = { markdown: body.markdown, version };
  const draftRef = useRef(body.markdown);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Sends run one after another, each reading the base when it starts. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const handlers = useRef<LiveMarkdownHandlers["current"]>({});
  handlers.current = { onAnchor };

  /** Put text in the editor as a head, not as typing: it is not sent, and undo does not reach it. */
  const setDoc = (text: string): void => {
    const editor = view.current;
    if (editor === null) return;
    const patch = textSplice(editor.state.doc.toString(), text);
    if (patch === null) return;
    editor.dispatch({
      changes: { from: patch.at, to: patch.at + patch.remove, insert: patch.insert },
      annotations: [fromHead.of(true), Transaction.addToHistory.of(false)],
    });
  };

  // A head that is not our own write is taken only when nothing is unsent.
  // With unsent text, `synced` stays on the old base, so the next send is
  // refused stale and the operator chooses; it never silently overwrites.
  useEffect(() => {
    if (version === synced.current.version) return;
    if (draftRef.current !== synced.current.markdown) return;
    synced.current = { markdown: body.markdown, version };
    draftRef.current = body.markdown;
    setDoc(body.markdown);
  }, [version, body.markdown]);

  /** Send what is unsent; resolves to the refusal line, or null when nothing is left unsent. */
  const send = (): Promise<string | null> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const sent = chain.current.then(async (): Promise<string | null> => {
      const text = draftRef.current;
      const patch = textSplice(synced.current.markdown, text);
      if (patch === null) return null;
      const base = synced.current.version;
      const refused = await onPatch(base, [patch]);
      setRefusal(refused);
      if (refused === null) synced.current = { markdown: text, version: (base + 1) as ArtifactVersion };
      return refused;
    });
    // A failed send must not stop the ones after it.
    chain.current = sent.then(
      () => undefined,
      () => undefined,
    );
    return sent;
  };

  const type = (text: string): void => {
    draftRef.current = text;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_REST_MS);
  };
  const latest = useRef({ type, send });
  latest.current = { type, send };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: draftRef.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          liveMarkdown(handlers),
          access.current.of(editable(readOnly)),
          placeholder("Nothing written yet."),
          EditorView.contentAttributes.of({ "aria-label": "Markdown", spellcheck: "true" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.every((tr) => tr.annotation(fromHead) === true)) {
              latest.current.type(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              const { from, to } = update.state.selection.main;
              const quote = update.state.sliceDoc(from, to);
              setSelection((prior) =>
                quote.trim().length === 0
                  ? null
                  : prior?.quote === quote && prior.offset === from
                    ? prior
                    : { quote, offset: from },
              );
            }
            if (update.focusChanged && !update.view.hasFocus) void latest.current.send();
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure(editable(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    const marks: DocumentAnchor[] = (anchors ?? []).map(({ threadId, anchor, count }) => ({
      id: threadId,
      quote: anchor.quote,
      offset: anchor.offset ?? 0,
      count,
    }));
    view.current?.dispatch({ effects: anchorsEffect(marks) });
  }, [anchors]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || revealAnchor === undefined) return;
    const { anchor, nonce } = revealAnchor;
    const effects = revealAnchorEffects(editor.state, { quote: anchor.quote, offset: anchor.offset ?? 0, nonce });
    if (effects !== null) editor.dispatch({ effects: [...effects] });
  }, [revealAnchor?.nonce]);

  const mounted = useRef(true);
  // Closing with typing still resting sends it rather than dropping it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) void send();
    };
  }, []);

  /**
   * The save a comment runs before posting. Once this editor is gone its
   * close already sent the draft, so the save is spent and main judges the
   * quote; it never resends an old draft whose buttons are gone.
   */
  const saveForComment = (): Promise<string | null> => (mounted.current ? send() : Promise.resolve(null));

  /** Write the draft over the newest head, replacing what the other writer changed. */
  const overwrite = (): void => {
    synced.current = head.current;
    void send();
  };

  const takeHead = (): void => {
    synced.current = head.current;
    draftRef.current = head.current.markdown;
    setDoc(head.current.markdown);
    setRefusal(null);
  };

  return (
    <div className="artifact-document" data-readonly={readOnly ? "true" : undefined}>
      {refusal ? (
        <div className="artifact-document__refusal" role="status">
          <span>{refusal}</span>
          <Button size="sm" variant="danger" onClick={overwrite}>
            Overwrite theirs
          </Button>
          <Button size="sm" variant="subtle" onClick={takeHead}>
            Take theirs
          </Button>
        </div>
      ) : null}
      <div className="artifact-document__surface">
        <div ref={host} className="artifact-document__live" />
        {selection && onCommentText ? (
          <div className="artifact-document__float">
            <Button
              size="sm"
              variant="chrome"
              // Pressing keeps the selection where it is.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onCommentText(selection.quote, selection.offset, saveForComment);
                setSelection(null);
              }}
            >
              <MessageSquarePlus size={13} aria-hidden />
              Comment on selection
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
