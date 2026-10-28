import { useEffect, useMemo, useRef, useState } from "react";
import { Tag, X } from "lucide-react";
import { ARTIFACT_LABELS_MAX, type ArtifactLabel, artifactLabelOf, artifactLabelsOf } from "@shared/artifact-labels";
import { claimFocus } from "../../lib/focus-ownership";
import { Combobox, IconButton } from "../ui";
import type { LabelChoice } from "./artifacts-pane-model";

/** Chips the header shows before the rest wait behind a count that opens the picker. */
const HEADER_CHIPS = 3;

const RULE = "Labels take lowercase letters, digits, spaces, - _ and /, up to 40 characters, with no / or space at either end.";
const FULL = `An artifact holds at most ${String(ARTIFACT_LABELS_MAX)} labels.`;

/** What the picker says while it offers nothing. */
const emptyLine = (query: string): string =>
  query.trim().length === 0 ? "Type to add labels." : artifactLabelOf(query) === undefined ? RULE : "Already here.";

type LabelOption = { readonly kind: "used" | "new"; readonly label: ArtifactLabel };

/**
 * What the picker offers for `query`: the node's labels this artifact does
 * not hold that contain it, and, when it folds to a label nobody uses yet,
 * that new one first, so the pointer can add it as Enter does.
 */
export const labelOptions = (
  used: ReadonlyArray<ArtifactLabel>,
  held: ReadonlyArray<ArtifactLabel>,
  query: string,
): ReadonlyArray<LabelOption> => {
  const needle = query.trim().toLowerCase();
  const typed = artifactLabelOf(query);
  const offered = used
    .filter((label) => !held.includes(label) && label.includes(needle))
    .map((label): LabelOption => ({ kind: "used", label }));
  return typed === undefined || used.includes(typed) || held.includes(typed)
    ? offered
    : [{ kind: "new", label: typed }, ...offered];
};

/**
 * Add what was typed to `held`: the whole next set, or why it cannot be. An
 * empty value or one already held changes nothing.
 */
export const addLabel = (
  held: ReadonlyArray<ArtifactLabel>,
  raw: string,
): { readonly labels: ReadonlyArray<ArtifactLabel> } | { readonly refused: string } | null => {
  if (raw.trim().length === 0) return null;
  const label = artifactLabelOf(raw);
  if (label === undefined) return { refused: RULE };
  if (held.includes(label)) return null;
  const labels = artifactLabelsOf([...held, label]);
  return labels === undefined ? { refused: FULL } : { labels };
};

/**
 * An artifact's labels in its header (0.11, 03): chips after the title,
 * each removable, and a picker that completes from the labels this node
 * already uses or adds a new one. Every change sends the whole next set; it
 * shows at once and goes back to the ruled set when it is refused, at once or
 * after it waited in the queue.
 */
export function ArtifactLabelChips({
  labels,
  used,
  readOnly,
  waiting,
  onChange,
}: {
  readonly labels: ReadonlyArray<ArtifactLabel>;
  /** Every label this Artifacts node uses, to complete from. */
  readonly used: ReadonlyArray<ArtifactLabel>;
  readonly readOnly: boolean;
  /** A labels write of this artifact's is queued, not yet ruled by the editing machine. */
  readonly waiting: boolean;
  /** Send the whole next set; how it was ruled, a failure to send reading as refused. */
  readonly onChange: (labels: ReadonlyArray<ArtifactLabel>) => Promise<"applied" | "queued" | "refused">;
}) {
  /**
   * The set last sent, shown until the ruled set changes, its write comes back
   * refused, or, queued, nothing waits any more: a queued write the editing
   * machine refused leaves the ruled set as it was. `seq` names the latest
   * send, so an earlier one ruled late never takes back a later one.
   */
  const [sent, setSent] = useState<{ readonly labels: ReadonlyArray<ArtifactLabel>; readonly seq: number; readonly queued: boolean } | null>(
    null,
  );
  const seq = useRef(0);
  const ruled = labels.join("\n");
  useEffect(() => setSent(null), [ruled]);
  useEffect(() => {
    if (!waiting) setSent((last) => (last?.queued === true ? null : last));
  }, [waiting]);
  const held = sent?.labels ?? labels;

  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | null>(null);
  const options = useMemo(() => labelOptions(used, held, query), [used, held, query]);

  const group = useRef<HTMLDivElement>(null);
  const field = (): HTMLElement | null | undefined => group.current?.querySelector<HTMLElement>('[role="combobox"]');
  /** Closed by its key or its button: focus goes back to the add button once the field is gone. */
  const refocus = useRef(false);
  const close = (): void => {
    refocus.current = true;
    setQuery("");
    setRefused(null);
    setPicking(false);
  };
  useEffect(() => {
    if (!picking) {
      if (refocus.current) claimFocus(group.current?.querySelector<HTMLElement>("[data-labels-trigger]"), "gesture");
      refocus.current = false;
      return;
    }
    claimFocus(field(), "gesture");
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && group.current?.contains(event.target)) return;
      setQuery("");
      setRefused(null);
      setPicking(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [picking]);

  const send = (next: ReadonlyArray<ArtifactLabel>): void => {
    const mine = ++seq.current;
    setSent({ labels: next, seq: mine, queued: false });
    const settle = (ruling: "applied" | "queued" | "refused"): void =>
      setSent((last) => {
        if (last?.seq !== mine) return last;
        if (ruling === "refused") return null;
        return ruling === "queued" ? { ...last, queued: true } : last;
      });
    void onChange(next).then(settle, () => settle("refused"));
  };
  const add = (raw: string): void => {
    const next = addLabel(held, raw);
    if (next !== null && "refused" in next) {
      setRefused(next.refused);
      return;
    }
    if (next !== null) send(next.labels);
    setQuery("");
    setActive(undefined);
    setRefused(null);
  };
  const remove = (label: ArtifactLabel): void => send(held.filter((one) => one !== label));

  if (held.length === 0 && readOnly) return null;

  const chip = (label: ArtifactLabel) => (
    <span key={label} className="artifact-labels__chip" title={label}>
      <span className="artifact-labels__word">{label}</span>
      {readOnly ? null : (
        <IconButton size="xs" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(label)}>
          <X size={11} />
        </IconButton>
      )}
    </span>
  );
  const hidden = held.length - HEADER_CHIPS;

  return (
    <div
      ref={group}
      className="artifact-labels"
      role="group"
      aria-label="Labels"
      onKeyDown={(event) => {
        if (event.key === "Escape" && picking) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <span className="artifact-labels__chips">{held.slice(0, HEADER_CHIPS).map(chip)}</span>
      {hidden > 0 ? (
        <button
          type="button"
          className="artifact-labels__more"
          aria-label={`${String(hidden)} more labels`}
          aria-expanded={picking}
          onClick={() => setPicking(true)}
        >
          +{hidden}
        </button>
      ) : null}
      {readOnly ? null : (
        <IconButton data-labels-trigger="" size="sm" aria-label="Add labels" title="Add labels" aria-expanded={picking} onClick={() => setPicking(true)}>
          <Tag size={13} />
        </IconButton>
      )}
      {!picking ? null : (
        <div className="artifact-labels__picker">
          {held.length > HEADER_CHIPS ? <div className="artifact-labels__held">{held.map(chip)}</div> : null}
          {readOnly ? null : (
            <Combobox
              value={query}
              onValueChange={(value) => {
                setQuery(value);
                setRefused(null);
              }}
              options={options}
              optionKey={(option) => `${option.kind}:${option.label}`}
              renderOption={(option) => (
                <span className="artifact-labels__option">{option.kind === "new" ? `Add "${option.label}"` : option.label}</span>
              )}
              activeKey={active}
              onActiveKeyChange={setActive}
              onCommit={(option, value) => add(option?.label ?? value)}
              onOptionClick={(option) => add(option.label)}
              aria-label="Find or add labels"
              listLabel="Labels"
              placeholder="Find or add"
              empty={refused === null ? <span className="artifact-labels__none">{emptyLine(query)}</span> : null}
              trailing={
                <IconButton size="xs" aria-label="Close" title="Close" onClick={close}>
                  <X size={11} />
                </IconButton>
              }
            />
          )}
          {refused === null ? null : (
            <p className="artifact-labels__refused" role="alert">
              {refused}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's Labels row (0.11, 03): a toggle per label with the rows it
 * would show, all picked ones held at once (AND), and Clear when any is.
 */
export function ArtifactLabelFilter({
  choices,
  onToggle,
  onClear,
}: {
  readonly choices: ReadonlyArray<LabelChoice>;
  readonly onToggle: (label: ArtifactLabel) => void;
  readonly onClear: () => void;
}) {
  if (choices.length === 0) return null;
  return (
    <div className="artifacts-filter__labels" role="group" aria-label="Labels">
      {choices.map(({ label, count, picked }) => (
        <button
          key={label}
          type="button"
          aria-pressed={picked}
          className="artifacts-filter__label"
          title={label}
          onClick={() => onToggle(label)}
        >
          <span className="artifacts-filter__label-word">{label}</span>
          <span className="artifacts-filter__label-count">{count}</span>
        </button>
      ))}
      {choices.some((choice) => choice.picked) ? (
        <button type="button" className="artifacts-filter__label artifacts-filter__label--clear" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
