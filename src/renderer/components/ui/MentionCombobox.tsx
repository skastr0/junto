import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type FocusEvent,
  type ReactElement,
  type Ref,
} from "react";
import { artifactLinkLabel } from "@shared/artifact-link";
import type { NodeKind } from "@shared/model/kinds";
import { MENTION_KIND_OF_NODE, type MentionKind, type MentionOf, type MentionRef } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import {
  artifactLinkCandidates,
  linkCandidateKey,
  linkCandidateLabel,
  linkQueryAt,
  type LinkableArtifact,
  type LinkCandidate,
} from "../../lib/artifact-link-draft";
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
  type MentionQuery,
  triggerOf,
  writtenText,
  type MentionCandidate,
  type MentionDraft,
  type MentionTrigger,
} from "../../lib/mention-draft";
import { ARTIFACT_TYPE_NOUN, RESOURCE_KIND_VISUAL, markColor } from "../../lib/resource-visuals";
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

/** What `[[` links to in a field, and how its host makes a document by a title: the document picker's shape. */
export type ComboboxLinks = {
  readonly artifacts: ReadonlyArray<LinkableArtifact>;
  /** Create a document titled `title` in the host's Artifacts node; its mention, or null when it was not made. Absent: no create row. */
  readonly create?: ((title: string) => Promise<MentionOf<"artifact"> | null>) | undefined;
};

const LINK_LIST_LABEL = "Artifacts to link";

/** A `[[` row: the artifact's glyph, title and place, or the create row in the words it does. */
export function LinkRowContent({ row }: { readonly row: LinkCandidate }) {
  if (row.kind === "create") {
    return (
      <>
        <ResourceGlyphMark kind="artifact" artifactType="document" />
        <span className="mention-combobox__label">{linkCandidateLabel(row)}</span>
        <span className="mention-combobox__kind">New</span>
      </>
    );
  }
  const { artifact } = row;
  return (
    <>
      <ResourceGlyphMark kind="artifact" artifactType={artifact.type} />
      <span className="mention-combobox__label">{artifact.title}</span>
      {artifact.place ? <span className="mention-combobox__detail">{artifact.place}</span> : null}
      <span className="mention-combobox__kind">{ARTIFACT_TYPE_NOUN[artifact.type]}</span>
    </>
  );
}

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
 *
 * With `links`, `[[` opens the same list on the artifacts in reach (plan
 * 0.11, 02): a pick goes in as a `[[Title]]` link, one unit like any
 * mention, and a title that names nothing offers to create a document by
 * it; the host creates, one at a time, and the link goes in where `[[` was.
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
  links,
  fieldRef,
  onKeyDown,
  onBlur,
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
  /** What `[[` links to; without it `[[` is only brackets. */
  readonly links?: ComboboxLinks | undefined;
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
  /** Keys the list did not take: send, new line, cancel. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The field lost the keyboard: a host that commits on leaving does it here. */
  readonly onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
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
  // The draft as it stands now, for a create that lands after more typing.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const shown = shownText(draft);
  const [caret, setCaret] = useState(shown.length);
  // The title a `[[` create is making: one at a time, and no create row meanwhile.
  const [creating, setCreating] = useState<string>();
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
  // A `[[` being typed, outside any placed mention, takes the list before @ and #.
  const typedLink = links === undefined ? undefined : linkQueryAt(shown.slice(0, caret));
  const linkQuery =
    typedLink !== undefined && !mentionSpans(draft).some((span) => span.start < caret && typedLink.start < span.end) ? typedLink : undefined;
  const mentionQuery = linkQuery === undefined ? mentionQueryAt(draft, caret) : undefined;
  const query = linkQuery ?? mentionQuery;
  const offered = useMemo(
    () => (mentionQuery === undefined ? [] : filterCandidates(candidates, mentionQuery)),
    [candidates, mentionQuery?.trigger, mentionQuery?.query],
  );
  const linkRows = useMemo(
    () =>
      linkQuery === undefined || links === undefined
        ? []
        : artifactLinkCandidates(links.artifacts, linkQuery.query).filter(
            (row) => row.kind === "artifact" || (links.create !== undefined && creating === undefined),
          ),
    [links, linkQuery?.query, creating],
  );
  const anyOfTrigger = mentionQuery !== undefined && candidates.some((candidate) => triggerOf(candidate.ref) === mentionQuery.trigger);
  const open = query !== undefined && query.start !== dismissedAt && !full && (linkQuery !== undefined || anyOfTrigger);
  const keys = linkQuery !== undefined ? linkRows.map(linkCandidateKey) : offered.map(candidateKey);
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

  // Escape shuts the list for the query it was pressed on, until that query ends: typing on keeps it shut, a new @ or # opens again.
  useEffect(() => {
    if (dismissedAt !== undefined && query?.start !== dismissedAt) setDismissedAt(undefined);
  }, [query?.start, dismissedAt]);

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
    if (mentionQuery === undefined) return;
    const next = pickCandidate(draft, mentionQuery, caret, candidate);
    pendingCaret.current = next.caret;
    setPicked(`Mentioned ${candidate.label}`);
    commit(next.draft, next.caret, next.shown);
  };

  /** The link goes in where its `[[` was typed: the brackets and the query become one `[[Title]]` unit. */
  const placeLink = (on: MentionDraft, at: MentionQuery, end: number, ref: MentionOf<"artifact">, title: string): void => {
    const next = pickCandidate(on, at, end, { ref, label: artifactLinkLabel(title) });
    pendingCaret.current = next.caret;
    commit(next.draft, next.caret, next.shown);
  };

  const pickLink = (row: LinkCandidate): void => {
    if (linkQuery === undefined) return;
    // pickCandidate replaces from `start` to the caret; the trigger it carries is not read.
    const at: MentionQuery = { trigger: "#", start: linkQuery.start, query: linkQuery.query };
    if (row.kind === "artifact") {
      placeLink(draft, at, caret, row.artifact.ref, row.artifact.title);
      setPicked(`Linked ${row.artifact.title}`);
      return;
    }
    const make = links?.create;
    if (make === undefined || creating !== undefined) return;
    const typed = `[[${linkQuery.query}`;
    setCreating(row.title);
    setPicked(`Creating ${row.title}`);
    void make(row.title).then(
      (ref) => {
        setCreating(undefined);
        if (ref === null) {
          setPicked(`${row.title} could not be created`);
          return;
        }
        // Typing went on while it was made: the link replaces the `[[` query only if that is still where it was.
        const now = draftNow.current;
        const stillTyped =
          shownText(now).startsWith(typed, at.start) &&
          !mentionSpans(now).some((span) => span.start < at.start + typed.length && at.start < span.end);
        if (stillTyped) placeLink(now, at, at.start + typed.length, ref, row.title);
        setPicked(`Created and linked ${row.title}`);
      },
      () => {
        setCreating(undefined);
        setPicked(`${row.title} could not be created`);
      },
    );
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
      { open, optionCount: keys.length, activeIndex },
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
        if (linkQuery !== undefined) {
          const row = linkRows[intent.index];
          if (row) pickLink(row);
          return;
        }
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
  const announcement = picked ?? listboxAnnouncement({ open, count: keys.length, noun });

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
          setPicked(undefined);
          commit(next.draft, next.caret, next.shown);
          if (mirror.current) mirror.current.scrollTop = element.scrollTop;
        }}
        onSelect={(event) => follow(event.currentTarget)}
        onScroll={(event) => follow(event.currentTarget)}
        onKeyDown={keyDown}
        onBlur={onBlur}
      />
      {open && linkQuery ? (
        <div className="mention-combobox__popup">
          <ul {...listboxAria(aria)} aria-label={LINK_LIST_LABEL} className="mention-combobox__list">
            {linkRows.map((row) => {
              const key = linkCandidateKey(row);
              return (
                <li
                  key={key}
                  {...optionAria(aria, key)}
                  className="mention-combobox__option"
                  data-active={key === active ? "true" : undefined}
                  data-testid="link-option"
                  data-kind={row.kind}
                  style={{ "--mark": markColor(RESOURCE_KIND_VISUAL.artifact.tone) } as CSSProperties}
                  // A press must not take the keyboard or the caret from the field.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickLink(row)}
                >
                  <LinkRowContent row={row} />
                </li>
              );
            })}
          </ul>
          {linkRows.length === 0 ? (
            <div className="mention-combobox__empty" data-testid="mention-empty">
              {creating === undefined ? "No matches" : `Creating ${creating}`}
            </div>
          ) : null}
        </div>
      ) : null}
      {open && mentionQuery ? (
        <div className="mention-combobox__popup">
          <ul {...listboxAria(aria)} aria-label={listLabel(mentionQuery.trigger)} className="mention-combobox__list">
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
