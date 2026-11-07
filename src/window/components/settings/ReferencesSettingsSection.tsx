/**
 * Settings -> References: named pieces of text the operator (and overseers)
 * write and any agent reads when it needs one. This page holds the app-wide
 * ones: the list, and one editor for adding or changing a reference. A
 * reference's name is how agents ask for it, so it is fixed once saved.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus } from "lucide-react";
import { APP_REFERENCE_PLACE, REFERENCE_NAME_MAX, type ReferenceSummary, type StoredReference } from "@shared/references";
import { ReferencesWindow } from "../../../contract/window/references";
import { follow, useWindowRuntime, useWindowService } from "../../rpc/runtime";
import { state$ } from "../../lib/state";
import { BriefingDocument } from "../briefing/BriefingDocument";
import { Button, ConfirmDialog, Input } from "../ui";
import { ChangedElsewhere, ImportFileButton, appendText, textSize } from "./text-edit";
import "./texts-settings.css";

type Draft = { readonly name: string; readonly description: string; readonly body: string };

const EMPTY: Draft = { name: "", description: "", body: "" };

const draftOf = (reference: StoredReference): Draft => ({
  name: reference.name,
  description: reference.description ?? "",
  body: reference.body,
});

const same = (a: Draft, b: Draft): boolean =>
  a.name === b.name && a.description === b.description && a.body === b.body;

/** "Deploy Notes.md" -> "deploy-notes": a starting name for a file brought in. */
export const nameFromFile = (fileName: string): string =>
  fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, REFERENCE_NAME_MAX);

function ReferenceEditor({
  name,
  onDone,
}: {
  /** The reference being changed, or undefined for a new one. */
  readonly name: string | undefined;
  readonly onDone: () => void;
}) {
  const runtime = useWindowRuntime();
  const references = useWindowService(ReferencesWindow);
  const canvasName = use$(state$.canvasName);
  // What is stored (EMPTY for a new one; undefined while it loads).
  const [base, setBase] = useState<Draft | undefined>(name === undefined ? EMPTY : undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // The stored text as it became while this edit was open; null: deleted.
  const [theirs, setTheirs] = useState<Draft | null>();
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const dirty = base !== undefined && !same(draft, base);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (name === undefined) return;
    // The reference as stored, then as it stands after each change to it.
    let first = true;
    const shown = (read: StoredReference | null): void => {
      const opening = first;
      first = false;
      const next = read ? draftOf(read) : null;
      if (opening || !dirtyRef.current) {
        if (next === null) {
          if (!opening) onDone();
          return;
        }
        setBase(next);
        setDraft(next);
        setTheirs(undefined);
      } else {
        setTheirs(next);
      }
    };
    return follow(runtime, references.ReferencesReadFollow({ place: APP_REFERENCE_PLACE, name }), shown);
  }, [runtime, references, name, onDone]);

  const conflict = theirs !== undefined && base !== undefined && (theirs === null || !same(theirs, base)) && dirty;

  const save = async (): Promise<void> => {
    if (!dirty || conflict) return;
    setSaving(true);
    setProblem(undefined);
    const description = draft.description.trim();
    const result = await runtime
      .runPromise(references.ReferencesWrite({
        place: APP_REFERENCE_PLACE,
        name: draft.name.trim(),
        body: draft.body,
        ...(description.length > 0 ? { description } : {}),
      }))
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }));
    setSaving(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    onDone();
  };

  const remove = async (): Promise<void> => {
    if (name === undefined) return;
    setSaving(true);
    const result = await runtime
      .runPromise(references.ReferencesDelete({ place: APP_REFERENCE_PLACE, name }))
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }));
    setSaving(false);
    setAsking(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    onDone();
  };

  return (
    <div className="settings-section texts-settings texts-settings--reference" data-testid="reference-editor">
      {conflict ? (
        <ChangedElsewhere
          what={theirs === null ? "This reference was deleted, or it" : "This reference"}
          onTakeTheirs={() => {
            if (theirs === null || theirs === undefined) {
              onDone();
              return;
            }
            setBase(theirs);
            setDraft(theirs);
            setTheirs(undefined);
          }}
          onKeepMine={() => {
            setBase(theirs ?? EMPTY);
            setTheirs(undefined);
          }}
        />
      ) : null}
      <div className="texts-settings__fields">
        <label className="texts-settings__field">
          Name
          <Input
            aria-label="Reference name"
            data-autofocus={name === undefined ? "" : undefined}
            spellCheck={false}
            autoComplete="off"
            maxLength={REFERENCE_NAME_MAX}
            placeholder="deploy-notes"
            disabled={name !== undefined}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value.toLowerCase() })}
          />
        </label>
        <label className="texts-settings__field">
          Description
          <Input
            aria-label="Reference description"
            placeholder="One line agents see in the list"
            disabled={base === undefined}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
      </div>
      <BriefingDocument
        canvasName={canvasName}
        value={draft.body}
        readOnly={base === undefined}
        label="Reference text"
        surfaceLabel={`${draft.name.trim() || "New reference"}, document`}
        placeholder="The reference as agents read it. @ names a seat, # a task or an artifact."
        onChange={(body) => setDraft((current) => ({ ...current, body }))}
      />
      <div className="texts-settings__bar">
        <ImportFileButton
          disabled={base === undefined}
          onImport={(file) =>
            setDraft((current) => ({
              ...current,
              name: name === undefined && current.name.length === 0 ? nameFromFile(file.name) : current.name,
              body: appendText(current.body, file.text),
            }))
          }
        />
        {name !== undefined ? (
          <Button variant="subtle" size="md" disabled={saving} onClick={() => setAsking(true)}>
            Delete
          </Button>
        ) : null}
        <span className="texts-settings__state" role="status">
          {dirty ? "Not saved" : ""}
        </span>
        <Button variant="subtle" size="md" disabled={saving} onClick={onDone}>
          {dirty ? "Discard" : "Back"}
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!dirty || saving || conflict || draft.name.trim().length === 0}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {problem ? (
        <p className="settings-error" role="alert">
          Not saved. {problem}
        </p>
      ) : null}
      {asking && name !== undefined ? (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirmLabel="Delete reference"
          busy={saving}
          testId="reference-delete-confirm"
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        >
          <p>Agents can no longer read it. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export function ReferencesSettingsSection() {
  const runtime = useWindowRuntime();
  const references = useWindowService(ReferencesWindow);
  const [list, setList] = useState<ReadonlyArray<ReferenceSummary>>();
  // What the editor holds: a reference's name, "" for a new one, or closed.
  const [editing, setEditing] = useState<string>();

  // The app-wide references, then as they stand after each change there.
  useEffect(
    () => follow(runtime, references.ReferencesListFollow({ place: APP_REFERENCE_PLACE }), setList, () => setList([])),
    [runtime, references],
  );

  // The list follows the store, so closing the editor reads nothing.
  const close = useCallback(() => setEditing(undefined), []);

  if (editing !== undefined) {
    return <ReferenceEditor key={editing} name={editing === "" ? undefined : editing} onDone={close} />;
  }

  return (
    <div className="settings-section texts-settings" data-testid="settings-references-section">
      {list === undefined ? null : list.length === 0 ? (
        <p className="settings-note">None yet.</p>
      ) : (
        <ul className="texts-settings__list" aria-label="References">
          {list.map((reference) => (
            <li key={reference.name}>
              <button
                type="button"
                className="texts-settings__row"
                aria-label={`Edit ${reference.name}`}
                onClick={() => setEditing(reference.name)}
              >
                <span className="texts-settings__name">{reference.name}</span>
                <span className="texts-settings__size">{textSize(reference.bytes)}</span>
                {reference.description ? (
                  <span className="texts-settings__about">{reference.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="texts-settings__bar">
        <Button variant="chrome" size="md" onClick={() => setEditing("")}>
          <Plus size={13} aria-hidden />
          New reference
        </Button>
      </div>
    </div>
  );
}
