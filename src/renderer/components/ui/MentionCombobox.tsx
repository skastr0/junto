import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type Ref,
} from "react";
import type { NodeKind } from "@shared/model/kinds";
import { MENTION_KIND_OF_NODE, type MentionKind, type MentionRef } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import { comboboxFieldAria, listboxAnnouncement, listboxAria, optionAria, type ListboxNoun } from "../../lib/listbox-aria";
import {
  candidateKey,
  draftMentions,
  draftOf,
  editDraft,
  filterCandidates,
  mentionKeyIntent,
  mentionQueryAt,
  mentionSpans,
  pickCandidate,
  shownText,
  triggerOf,
  writtenText,
  type MentionCandidate,
  type MentionDraft,
  type MentionTrigger,
} from "../../lib/mention-draft";
import { RESOURCE_KIND_VISUAL, markColor } from "../../lib/resource-visuals";
import { Textarea } from "./Field";
import { ResourceGlyphMark, mentionMark } from "./ResourceChip";
import "./mention-combobox.css";

const NODE_KIND_OF_MENTION: Readonly<Record<MentionKind, NodeKind>> = Object.fromEntries(
  Object.entries(MENTION_KIND_OF_NODE).map(([node, mention]) => [mention, node]),
) as Record<MentionKind, NodeKind>;

// What the mirror copies from the field so its text lies exactly under the field's.
const MIRRORED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "tabSize",
  "textIndent",
  "wordSpacing",
] as const;

/**
 * House mention field: a textarea where @ names a seat or a page and # a
 * task or an artifact, with the list of who or what may be named under it.
 *
 * The value is the written text, each mention a link to its node
 * (`src/shared/mention.ts`); the field shows each one as its label, drawn as
 * a chip. The chips are a mirror behind nothing: aria-hidden, pointer
 * transparent, the field's own text is what is read and edited. A mention
 * is one unit: deleting into it removes it whole, typing inside it turns it
 * back into words.
 *
 * It knows nothing about who may be mentioned (the composer passes its
 * availability sources' candidates) or what a mention does (the composer's
 * send). Keys: Up and Down move, Enter and Tab put the highlighted one in,
 * Escape closes the list only. Every other key, send included, is the
 * composer's, through `onKeyDown`.
 */
export function MentionCombobox({
  value,
  onValueChange,
  canvasName,
  candidates,
  listLabel,
  noun = { one: "match", other: "matches" },
  nodeKindOf,
  maxMentions,
  placement = "below",
  fieldRef,
  onKeyDown,
  dense = false,
  rows,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
  "aria-keyshortcuts": ariaKeyShortcuts,
  "data-testid": testId,
}: {
  /** The written text: mentions as links. */
  readonly value: string;
  /** The written text after an edit, and what it now mentions, once each, in order. */
  readonly onValueChange: (value: string, mentions: ReadonlyArray<MentionRef>) => void;
  /** The canvas the links name. */
  readonly canvasName: string;
  /** Everything that may be mentioned here, from the composer's availability sources. */
  readonly candidates: ReadonlyArray<MentionCandidate>;
  /** The list's name for a trigger, such as "Seats connected to product-feed". */
  readonly listLabel: (trigger: MentionTrigger) => string;
  /** What the live region counts. */
  readonly noun?: ListboxNoun;
  /**
   * Reads the links already in `value` back as mentions. Defaults to the
   * candidates' own nodes, so a link to something no longer offered stays words.
   */
  readonly nodeKindOf?: (nodeId: NodeId) => NodeKind | undefined;
  /** No list opens once the text names this many. */
  readonly maxMentions?: number;
  /** Where the list opens: under the field, or over it for a composer at the foot of a pane. */
  readonly placement?: "below" | "above";
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
  /** Keys the list did not take: send, new line, cancel. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly dense?: boolean;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly "aria-label": string;
  readonly "aria-keyshortcuts"?: string;
  readonly "data-testid"?: string;
}) {
  const baseId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement | null>(null);
  const pendingCaret = useRef<number | undefined>(undefined);

  const kindOf = useMemo(() => {
    if (nodeKindOf) return nodeKindOf;
    const known = new Map(candidates.map((candidate) => [candidate.ref.nodeId, NODE_KIND_OF_MENTION[candidate.ref.kind]]));
    return (nodeId: NodeId) => known.get(nodeId);
  }, [nodeKindOf, candidates]);

  // The draft follows `value`: a value this field wrote keeps its pieces; any
  // other (cleared after a send, a draft put back) is read from the links.
  const [draft, setDraft] = useState<MentionDraft>(() => draftOf(value, kindOf));
  const wrote = useRef(value);
  if (value !== wrote.current) {
    wrote.current = value;
    const next = draftOf(value, kindOf);
    setDraft(next);
  }
  const shown = shownText(draft);
  const [caret, setCaret] = useState(shown.length);
  const [dismissedAt, setDismissedAt] = useState<number>();
  const [activeKey, setActiveKey] = useState<string>();
  // What the live region says after a pick, until the next edit: the list
  // closes as the mention goes in, so the pick itself must be heard.
  const [picked, setPicked] = useState<string>();

  const commit = (next: MentionDraft, at: number, fieldValue: string): void => {
    setDraft(next);
    setCaret(at);
    // The field already holds what was typed; it needs the caret put back only
    // when the text it shows is not what was typed (a whole mention went).
    if (field.current && field.current.value !== fieldValue) pendingCaret.current = at;
    const written = writtenText(next, canvasName);
    wrote.current = written;
    onValueChange(written, draftMentions(next));
  };

  const mentioned = draftMentions(draft);
  const full = maxMentions !== undefined && mentioned.length >= maxMentions;
  const query = mentionQueryAt(draft, caret);
  const offered = useMemo(
    () => (query === undefined ? [] : filterCandidates(candidates, query)),
    [candidates, query?.trigger, query?.query],
  );
  const anyOfTrigger = query !== undefined && candidates.some((candidate) => triggerOf(candidate.ref) === query.trigger);
  const open = query !== undefined && query.start !== dismissedAt && anyOfTrigger && !full;
  const keys = offered.map(candidateKey);
  const active = activeKey !== undefined && keys.includes(activeKey) ? activeKey : keys[0];
  const activeIndex = active === undefined ? -1 : keys.indexOf(active);

  const aria = {
    baseId,
    presentation: "popup" as const,
    autocomplete: "list" as const,
    open,
    keys,
    activeKey: active,
    selection: { kind: "highlight" as const },
  };

  // A query that changes starts the highlight from the top.
  useEffect(() => {
    setActiveKey(undefined);
  }, [query?.start, query?.query]);

  // Put the caret where an edit left it, once the field holds the new text.
  useLayoutEffect(() => {
    const element = field.current;
    const at = pendingCaret.current;
    if (!element || at === undefined) return;
    pendingCaret.current = undefined;
    element.setSelectionRange(at, at);
  }, [draft]);

  // The mirror wears the field's box and type, and follows its scroll.
  useLayoutEffect(() => {
    const element = field.current;
    const copy = mirror.current;
    if (!element || !copy) return;
    const style = getComputedStyle(element);
    for (const property of MIRRORED) copy.style[property] = style[property];
    copy.style.height = `${element.clientHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    copy.scrollTop = element.scrollTop;
  });

  const follow = (element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart ?? element.value.length);
    if (mirror.current) mirror.current.scrollTop = element.scrollTop;
  };

  const pick = (candidate: MentionCandidate): void => {
    if (query === undefined) return;
    const next = pickCandidate(draft, query, caret, candidate);
    pendingCaret.current = next.caret;
    setPicked(`Mentioned ${candidate.label}`);
    commit(next.draft, next.caret, next.shown);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const intent = mentionKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing,
      },
      { open, optionCount: offered.length, activeIndex },
    );
    switch (intent.type) {
      case "highlight": {
        event.preventDefault();
        setActiveKey(keys[intent.index]);
        return;
      }
      case "pick": {
        event.preventDefault();
        event.stopPropagation();
        const candidate = offered[intent.index];
        if (candidate) pick(candidate);
        return;
      }
      case "dismiss":
        // The list closes; the dialog, popover or pane around stays.
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(query?.start);
        return;
      case "none":
        onKeyDown?.(event);
    }
  };

  const setField = (element: HTMLTextAreaElement | null): void => {
    field.current = element;
    if (typeof fieldRef === "function") fieldRef(element);
    else if (fieldRef) (fieldRef as { current: HTMLTextAreaElement | null }).current = element;
  };

  const spans = mentionSpans(draft);
  const announcement = picked ?? listboxAnnouncement({ open, count: offered.length, noun });

  return (
    <div className="mention-combobox" data-placement={placement}>
      <div ref={mirror} aria-hidden className="mention-combobox__mirror">
        {spans.reduce<{ readonly at: number; readonly parts: ReactElement[] }>(
          ({ at, parts }, span, index) => ({
            at: span.end,
            parts: [
              ...parts,
              <span key={`t${index}`}>{shown.slice(at, span.start)}</span>,
              <span
                key={`m${index}`}
                className="mention-combobox__chip"
                data-kind={span.ref.kind}
                style={{ "--mark": markColor(RESOURCE_KIND_VISUAL[span.ref.kind].tone) } as CSSProperties}
              >
                {shown.slice(span.start, span.end)}
              </span>,
            ],
          }),
          { at: 0, parts: [] },
        ).parts}
        {/* The tail, and a space so a trailing newline still takes its line. */}
        <span>{`${shown.slice(spans.at(-1)?.end ?? 0)} `}</span>
      </div>
      <Textarea
        ref={setField}
        dense={dense}
        rows={rows}
        className="mention-combobox__field"
        {...comboboxFieldAria(aria)}
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyShortcuts}
        data-testid={testId}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck
        value={shown}
        onChange={(event) => {
          const element = event.currentTarget;
          const next = editDraft(draft, element.value);
          setDismissedAt(undefined);
          setPicked(undefined);
          commit(next.draft, next.caret, next.shown);
          if (mirror.current) mirror.current.scrollTop = element.scrollTop;
        }}
        onSelect={(event) => follow(event.currentTarget)}
        onScroll={(event) => follow(event.currentTarget)}
        onKeyDown={keyDown}
      />
      {open && query ? (
        <div className="mention-combobox__popup">
          <ul {...listboxAria(aria)} aria-label={listLabel(query.trigger)} className="mention-combobox__list">
            {offered.map((candidate) => {
              const key = candidateKey(candidate);
              const visual = RESOURCE_KIND_VISUAL[candidate.ref.kind];
              return (
                <li
                  key={key}
                  {...optionAria(aria, key)}
                  className="mention-combobox__option"
                  data-active={key === active ? "true" : undefined}
                  data-testid="mention-option"
                  style={{ "--mark": markColor(visual.tone) } as CSSProperties}
                  // A press must not take the keyboard or the caret from the field.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(candidate)}
                >
                  <ResourceGlyphMark {...mentionMark(candidate.ref)} />
                  <span className="mention-combobox__label">{candidate.label}</span>
                  {candidate.detail ? <span className="mention-combobox__detail">{candidate.detail}</span> : null}
                  <span className="mention-combobox__kind">{visual.noun}</span>
                  {candidate.note ? <span className="mention-combobox__note">{candidate.note}</span> : null}
                </li>
              );
            })}
          </ul>
          {offered.length === 0 ? (
            <div className="mention-combobox__empty" data-testid="mention-empty">
              No matches
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
