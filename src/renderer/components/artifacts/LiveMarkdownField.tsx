import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { mentionRefOf, parseMentionHref } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { claimFocus, releaseFocus } from "../../lib/focus-ownership";
import type { MentionCandidate } from "../../lib/mention-draft";
import { openMention } from "../../lib/mention-open";
import { usePreviewFace } from "../../lib/use-preview-face";
import { PreviewCard } from "../embeds/PreviewCard";
import { textSplice } from "./artifacts-pane-model";
import { DocumentMentionChip } from "./DocumentMentionChip";
import { liveMarkdown, type LiveMarkdownHandlers, type MentionMount, redrawEffect } from "./live-markdown";
import { mentionPicker, mentionSourceChanged } from "./mention-picker";
import "./live-markdown.css";

/** What the field may mention, and how it reads the canvas its links name. */
export type DocumentMentions = {
  readonly canvasName: string;
  readonly candidates: ReadonlyArray<MentionCandidate>;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
};

/** What a host does to the field that is not typing. */
export type LiveMarkdownFieldHandle = {
  /** The editor, for a host's own effects (anchors, reveals). */
  readonly view: () => EditorView | null;
  /** Put text in as not typed: it is not reported, and undo does not reach it. */
  readonly replace: (text: string) => void;
};

/** A selection worth acting on, as the text and where it starts. */
export type FieldSelection = { readonly quote: string; readonly offset: number };

/** How long typing rests before `onRest` hears it. */
const REST_MS = 800;

/** Marks a change that came from the host, not from the operator's typing. */
const fromHost = Annotation.define<boolean>();

const editable = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

const keys = new WeakMap<HTMLElement, string>();
let nextKey = 0;
/** A portal's key: one per widget host, for as long as it lives. */
const keyOf = (element: HTMLElement): string => {
  let key = keys.get(element);
  if (key === undefined) {
    nextKey += 1;
    key = `mention-${nextKey}`;
    keys.set(element, key);
  }
  return key;
};

/** An embed line: the preview card of what the link names, greyed when it is gone. */
function Embed({ href, label, mentions }: { readonly href: string; readonly label: string; readonly mentions: DocumentMentions }) {
  const target = parseMentionHref(href);
  const ref = target === undefined ? undefined : mentionRefOf(target, mentions.nodeKindOf);
  const face = usePreviewFace(ref, mentions.canvasName, label);
  return <PreviewCard {...face} size="block" {...(ref === undefined ? {} : { onOpen: () => openMention(ref) })} />;
}

/**
 * Markdown edited live: always rendered, the lines under the caret in
 * source, mentions drawn as chips and embeds as preview cards, @ and #
 * offering what may be named. The text is the markdown, byte for byte.
 *
 * The surface takes the keyboard without writing: Enter writes at the caret
 * it left, Escape stops writing and keeps the surface. A host hears every
 * edit (`onChange`) and each rest (`onRest`: typing paused, the field was
 * left, or it closed with typing unheard). `value` is what the field opens
 * on; a host that must put text in later uses the handle's `replace`.
 */
export function LiveMarkdownField({
  value,
  readOnly = false,
  mentions,
  label,
  surfaceLabel,
  placeholder = "Nothing written yet.",
  restMs = REST_MS,
  onChange,
  onRest,
  onSelection,
  onAnchor,
  className,
  handle,
}: {
  /** The text the field opens on. */
  readonly value: string;
  readonly readOnly?: boolean;
  /** Mentions drawn as chips and embeds, and offered on @ and #. Without it a mention reads as its words. */
  readonly mentions?: DocumentMentions | undefined;
  /** The text box's name. */
  readonly label: string;
  /** The surface's name, such as "Launch plan, document". */
  readonly surfaceLabel: string;
  readonly placeholder?: string;
  readonly restMs?: number;
  /** Every edit the operator makes, as the whole text. */
  readonly onChange?: ((text: string) => void) | undefined;
  /** Typing paused, the field was left, or it closed with typing unheard. */
  readonly onRest?: ((text: string) => void) | undefined;
  /** The main selection when it holds words, or null. */
  readonly onSelection?: ((selection: FieldSelection | null) => void) | undefined;
  /** A press on a comment anchor's mark. */
  readonly onAnchor?: ((id: string) => void) | undefined;
  readonly className?: string;
  readonly handle?: Ref<LiveMarkdownFieldHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The hosts the editor's mention widgets made, each drawn into by a portal. */
  const [mounts, setMounts] = useState<ReadonlyMap<HTMLElement, MentionMount>>(new Map());
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const heard = useRef({ onChange, onRest, onSelection, restMs });
  heard.current = { onChange, onRest, onSelection, restMs };
  const handlers = useRef<LiveMarkdownHandlers["current"]>({});
  handlers.current = {
    onAnchor,
    ...(mentions === undefined
      ? {}
      : {
          openMention: (href) => {
            const target = parseMentionHref(href);
            const ref = target === undefined ? undefined : mentionRefOf(target, mentions.nodeKindOf);
            if (ref !== undefined) openMention(ref);
          },
          mount: (element, mention) => setMounts((prior) => new Map(prior).set(element, mention)),
          unmount: (element) =>
            setMounts((prior) => {
              if (!prior.has(element)) return prior;
              const next = new Map(prior);
              next.delete(element);
              return next;
            }),
        }),
  };

  /** Tell the host typing rested, if any is unheard. */
  const rest = (): void => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    heard.current.onRest?.(view.current?.state.doc.toString() ?? value);
  };
  const restRef = useRef(rest);
  restRef.current = rest;

  useImperativeHandle(
    handle,
    () => ({
      view: () => view.current,
      replace: (text) => {
        const editor = view.current;
        if (editor === null) return;
        const patch = textSplice(editor.state.doc.toString(), text);
        if (patch === null) return;
        editor.dispatch({
          changes: { from: patch.at, to: patch.at + patch.remove, insert: patch.insert },
          annotations: [fromHost.of(true), Transaction.addToHistory.of(false)],
        });
      },
    }),
    [],
  );

  /** Escape stops writing: the surface keeps the keyboard, and every line renders. */
  const stopWriting = (editor: EditorView): boolean => {
    if (claimFocus(host.current, "gesture")) return true;
    return releaseFocus(editor.contentDOM, "gesture");
  };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          liveMarkdown(handlers),
          mentionPicker(() => ({ canvasName: mentionsRef.current?.canvasName ?? "", candidates: mentionsRef.current?.candidates ?? [] })),
          keymap.of([{ key: "Escape", run: stopWriting }]),
          access.current.of(editable(readOnly)),
          placeholderText(placeholder),
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "true" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.every((tr) => tr.annotation(fromHost) === true)) {
              const text = update.state.doc.toString();
              heard.current.onChange?.(text);
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = setTimeout(() => restRef.current(), heard.current.restMs);
            }
            if (update.docChanged || update.selectionSet) {
              const { from, to } = update.state.selection.main;
              const quote = update.state.sliceDoc(from, to);
              heard.current.onSelection?.(quote.trim().length === 0 ? null : { quote, offset: from });
            }
            if (update.focusChanged && !update.view.hasFocus) restRef.current();
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      // Closing with typing unheard tells the host rather than dropping it.
      restRef.current();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure(editable(readOnly)) });
  }, [readOnly]);

  // Mentions that arrive after the editor drew its widgets: they are drawn again, as chips and cards.
  const drawsMentions = mentions !== undefined;
  useEffect(() => {
    if (drawsMentions) view.current?.dispatch({ effects: redrawEffect.of(null) });
  }, [drawsMentions]);

  // Candidates that arrive while the list is open draw at once.
  useEffect(() => {
    if (view.current !== null) mentionSourceChanged(view.current);
  }, [mentions?.candidates]);

  // A drawn chip or card has its size now: the editor measures again.
  useLayoutEffect(() => {
    view.current?.requestMeasure();
  }, [mounts]);

  /** Enter on the surface writes again, at the caret it left. */
  const onSurfaceKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.key !== "Enter" || readOnly) return;
    event.preventDefault();
    claimFocus(view.current?.contentDOM, "gesture", { event: event.nativeEvent });
  };

  return (
    <>
      <div
        ref={host}
        className={className ? `live-markdown ${className}` : "live-markdown"}
        data-readonly={readOnly ? "true" : undefined}
        tabIndex={0}
        role="group"
        aria-label={surfaceLabel}
        aria-keyshortcuts="Enter"
        onKeyDown={onSurfaceKey}
      />
      {mentions
        ? [...mounts].map(([element, mention]) =>
            createPortal(
              mention.kind === "embed" ? (
                <Embed href={mention.href} label={mention.label} mentions={mentions} />
              ) : (
                <DocumentMentionChip href={mention.href} label={mention.label} nodeKindOf={mentions.nodeKindOf} />
              ),
              element,
              keyOf(element),
            ),
          )
        : null}
    </>
  );
}
