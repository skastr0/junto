import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type Tooltip, type TooltipView, showTooltip } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { useLayoutEffect, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { mentionLink } from "@shared/mention";
import { listboxAnnouncement, listboxAria, optionAria, optionId, listboxId, type ListboxAriaState } from "../../lib/listbox-aria";
import {
  candidateKey,
  filterCandidates,
  mentionKeyIntent,
  mentionQueryAt,
  triggerOf,
  type MentionCandidate,
  type MentionTrigger,
} from "../../lib/mention-draft";
import { RESOURCE_KIND_VISUAL, markColor } from "../../lib/resource-visuals";
import { ResourceGlyphMark, mentionMark } from "../ui/ResourceChip";
import "../ui/mention-combobox.css";
import "./mention-picker.css";

/**
 * The @ and # list inside a live markdown document: the house mention list
 * (`ui/MentionCombobox`) on a CodeMirror surface. @ names a seat or a page,
 * # a task or an artifact, with the same filter, keys and words as every
 * other composer (`lib/mention-draft.ts`). A pick writes the mention as its
 * link, `[@product-feed](junto://...)`, as one `input.mention` change, so the
 * document saves it as it saves typing; drawing the link as a chip is the
 * editor's.
 *
 * It knows nothing about who may be mentioned: the source is read at the
 * moment the list draws or a key lands. A host whose candidates arrive while
 * the caret rests calls `mentionSourceChanged` so the list draws them then.
 */

/** What may be mentioned, read when it is needed. */
export type MentionPickerSource = () => {
  readonly canvasName: string;
  readonly candidates: ReadonlyArray<MentionCandidate>;
};

/** The mention being typed at the caret, as document positions: the trigger at `from`, the caret at `to`. */
export type PickerQuery = {
  readonly trigger: MentionTrigger;
  readonly from: number;
  readonly to: number;
  readonly query: string;
};

const PARSE_BUDGET_MS = 25;

/** Where a mention cannot go: code, and a link's own text or address. */
const OFF_LIMITS = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "Link", "Image", "URL", "Autolink"]);

/**
 * The mention typed just before the caret, if one can be written there. A
 * # that begins its line is a heading until a letter follows it, so typing
 * `# Title` never opens the list.
 *
 * Code is known only once the syntax reaches the caret. Until it does, far
 * down a long document, the list waits closed rather than guess: it opens
 * when the editor's own parse arrives, a beat later, never inside a fence.
 */
export const pickerQueryAt = (state: EditorState, budgetMs: number = PARSE_BUDGET_MS): PickerQuery | null => {
  const caret = state.selection.main;
  if (state.readOnly || !caret.empty) return null;
  const line = state.doc.lineAt(caret.head);
  const before = line.text.slice(0, caret.head - line.from);
  const found = mentionQueryAt([{ kind: "text", text: before }], before.length);
  if (found === undefined) return null;
  if (found.trigger === "#" && found.query === "" && before.slice(0, found.start).trim() === "") return null;
  // Parse up to the caret, bounded so a keystroke never waits long.
  const tree = ensureSyntaxTree(state, caret.head, budgetMs);
  if (tree === null) return null;
  for (let node: SyntaxNode | null = tree.resolveInner(caret.head, -1); node; node = node.parent) {
    if (OFF_LIMITS.has(node.name)) return null;
  }
  return { trigger: found.trigger, from: line.from + found.start, to: caret.head, query: found.query };
};

const pickerSource = Facet.define<MentionPickerSource, MentionPickerSource | undefined>({ combine: (sources) => sources[0] });

const setActive = StateEffect.define<string>();
const dismiss = StateEffect.define<null>();
const announce = StateEffect.define<string>();

type Picker = {
  /** This editor's list ids. */
  readonly baseId: string;
  readonly query: PickerQuery | null;
  /** Escape closed the list for the query that starts here, until that query ends, as the house field does. */
  readonly dismissed: number | null;
  readonly active: string | undefined;
  /** What the live region says after a pick, until the next edit. */
  readonly picked: string | undefined;
  readonly tooltip: Tooltip | null;
};

let pickers = 0;

const sameQuery = (a: PickerQuery | null, b: PickerQuery | null): boolean =>
  a === b || (a !== null && b !== null && a.from === b.from && a.query === b.query && a.trigger === b.trigger);

const pickerField = StateField.define<Picker>({
  create: () => {
    pickers += 1;
    return { baseId: `mention-picker-${pickers}`, query: null, dismissed: null, active: undefined, picked: undefined, tooltip: null };
  },
  update: (value, tr) => {
    let { dismissed, active, picked } = value;
    if (tr.docChanged) {
      if (dismissed !== null) dismissed = tr.changes.mapPos(dismissed);
      picked = undefined;
    }
    // A parse that reaches further can show the list a query was waiting on.
    const parsed = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const query = tr.docChanged || tr.selection !== undefined || tr.reconfigured || parsed ? pickerQueryAt(tr.state) : value.query;
    // A query that changes starts the highlight from the top.
    if (!sameQuery(query, value.query)) active = undefined;
    // A dismissal lasts while its query does: typing on keeps the list shut; a new @ or # opens again.
    if (query === null || query.from !== dismissed) dismissed = null;
    for (const effect of tr.effects) {
      if (effect.is(setActive)) active = effect.value;
      if (effect.is(dismiss)) dismissed = query?.from ?? null;
      if (effect.is(announce)) picked = effect.value;
    }
    const shown = query !== null && query.from !== dismissed;
    const tooltip = !shown
      ? null
      : value.tooltip !== null && value.query?.from === query.from
        ? value.tooltip
        : { pos: query.from, above: false, arrow: false, create: listView };
    return { baseId: value.baseId, query, dismissed, active, picked, tooltip };
  },
  provide: (field) => showTooltip.from(field, (picker) => picker.tooltip),
});

/** The list as it stands: open only for a query whose trigger has anything to offer. */
type Shown = {
  readonly open: boolean;
  readonly query: PickerQuery | null;
  readonly offered: ReadonlyArray<MentionCandidate>;
  readonly aria: ListboxAriaState;
  readonly activeIndex: number;
  readonly announcement: string;
};

const NOUN = { one: "match", other: "matches" } as const;

const shownOf = (state: EditorState): Shown => {
  const picker = state.field(pickerField);
  const { query } = picker;
  const candidates = query === null || picker.tooltip === null ? [] : (state.facet(pickerSource)?.().candidates ?? []);
  const open = query !== null && picker.tooltip !== null && candidates.some((candidate) => triggerOf(candidate.ref) === query.trigger);
  const offered = open ? filterCandidates(candidates, query) : [];
  const keys = offered.map(candidateKey);
  const active = picker.active !== undefined && keys.includes(picker.active) ? picker.active : keys[0];
  const aria: ListboxAriaState = {
    baseId: picker.baseId,
    presentation: "popup",
    autocomplete: "list",
    open,
    keys,
    activeKey: active,
    selection: { kind: "highlight" },
  };
  const announcement = picker.picked ?? listboxAnnouncement({ open, count: offered.length, noun: NOUN });
  return { open, query, offered, aria, activeIndex: active === undefined ? -1 : keys.indexOf(active), announcement };
};

/** Put the candidate in place of the query as its link, followed by one space, and the caret after it. */
const pick = (view: EditorView, candidate: MentionCandidate): void => {
  const { query } = view.state.field(pickerField);
  const source = view.state.facet(pickerSource);
  if (query === null || source === undefined) return;
  const link = mentionLink(candidate.ref, candidate.label, source().canvasName);
  const spaced = view.state.sliceDoc(query.to, query.to + 1) === " ";
  view.dispatch({
    changes: { from: query.from, to: query.to, insert: spaced ? link : `${link} ` },
    selection: { anchor: query.from + link.length + 1 },
    effects: announce.of(`Mentioned ${candidate.label}`),
    userEvent: "input.mention",
    scrollIntoView: true,
  });
};

const LIST_LABEL: Readonly<Record<MentionTrigger, string>> = {
  "@": "Seats and pages to mention",
  "#": "Tasks and artifacts to mention",
};

function PickerList({
  view,
  shown,
  onDrawn,
}: {
  readonly view: EditorView;
  readonly shown: Shown;
  /** Runs once these rows are in the DOM, before paint. */
  readonly onDrawn: () => void;
}) {
  const { aria, offered, query } = shown;
  useLayoutEffect(() => {
    onDrawn();
  });
  if (query === null) return null;
  return (
    <>
      <ul {...listboxAria(aria)} aria-label={LIST_LABEL[query.trigger]} className="mention-combobox__list">
        {offered.map((candidate) => {
          const key = candidateKey(candidate);
          const visual = RESOURCE_KIND_VISUAL[candidate.ref.kind];
          return (
            <li
              key={key}
              {...optionAria(aria, key)}
              className="mention-combobox__option"
              data-active={key === aria.activeKey ? "true" : undefined}
              data-testid="mention-option"
              style={{ "--mark": markColor(visual.tone) } as CSSProperties}
              // A press must not take the keyboard or the caret from the document.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(view, candidate)}
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
    </>
  );
}

/** The list under the trigger, drawn by React into the tooltip CodeMirror places. */
function listView(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "mention-picker";
  dom.dataset.testid = "document-mention-picker";
  const root = createRoot(dom);
  dom.hidden = true;
  const draw = (): void => {
    const shown = shownOf(view.state);
    // Off the document, the list waits hidden for the operator to come back to it.
    const visible = shown.open && view.hasFocus;
    // Hiding is at once; showing waits for React to commit the rows, so an empty box never paints.
    if (!visible) dom.hidden = true;
    root.render(<PickerList view={view} shown={shown} onDrawn={() => (dom.hidden = !visible)} />);
  };
  draw();
  return {
    dom,
    update: draw,
    // An editor torn down inside a React commit must not unmount a root synchronously.
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}

/** The polite live region: the count as the query changes, then the pick. */
const announcer = ViewPlugin.define((view) => {
  const region = document.createElement("span");
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.dataset.testid = "document-mention-announcer";
  view.dom.append(region);
  const say = (state: EditorState): void => {
    const text = shownOf(state).announcement;
    if (region.textContent !== text) region.textContent = text;
  };
  say(view.state);
  return {
    update: (update) => say(update.state),
    destroy: () => region.remove(),
  };
});

/** The document stays a textbox; while the list shows, it names the list and the highlighted option. */
const fieldAria = EditorView.contentAttributes.of((view) => {
  const { open, aria } = shownOf(view.state);
  const attrs: Record<string, string> = { "aria-autocomplete": "list", "aria-haspopup": "listbox" };
  if (open) attrs["aria-controls"] = listboxId(aria.baseId);
  if (open && aria.activeKey !== undefined) attrs["aria-activedescendant"] = optionId(aria.baseId, aria.activeKey);
  return attrs;
});

/**
 * Keys while the list shows: Up and Down move (wrapping), Enter and Tab put
 * the highlighted one in, Escape closes the list only. Every other key, and
 * these with nothing to pick, stay the document's.
 */
const pickerKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (event, view) => {
      const shown = shownOf(view.state);
      const intent = mentionKeyIntent(event, {
        open: shown.open && view.hasFocus,
        optionCount: shown.offered.length,
        activeIndex: shown.activeIndex,
      });
      switch (intent.type) {
        case "none":
          return false;
        case "highlight": {
          event.preventDefault();
          const key = shown.aria.keys[intent.index];
          if (key !== undefined) view.dispatch({ effects: setActive.of(key) });
          return true;
        }
        case "pick": {
          event.preventDefault();
          event.stopPropagation();
          const candidate = shown.offered[intent.index];
          if (candidate) pick(view, candidate);
          return true;
        }
        case "dismiss":
          // The list closes; the pane around stays.
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({ effects: dismiss.of(null) });
          return true;
      }
    },
  }),
);

/** The candidates changed while nothing else did: the list draws what is offered now. */
export const mentionSourceChanged = (view: EditorView): void => view.dispatch({});

/** The @ and # list for a live markdown document. */
export const mentionPicker = (source: MentionPickerSource): Extension => [
  pickerSource.of(source),
  pickerField,
  pickerKeys,
  fieldAria,
  announcer,
];
