/**
 * Settings -> Briefing: the one app-wide text every agent gets when it
 * starts. The operator writes it here, or brings in an AGENTS.md or
 * CLAUDE.md. An overseer may write it too, so the page reads again on every
 * change and never saves an edit over a text the operator has not seen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppBriefing } from "@shared/references";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, Textarea } from "../ui";
import { ChangedElsewhere, ImportFileButton, appendText } from "./text-edit";
import "./texts-settings.css";

export function BriefingSettingsSection() {
  const api = getJuntoApi();
  // The text as stored, and the edit on top of it (undefined: no edit open).
  const [stored, setStored] = useState<AppBriefing | null>();
  const [draft, setDraft] = useState<string>();
  // A newer stored text that arrived while an edit was open.
  const [theirs, setTheirs] = useState<AppBriefing | null>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const read = useCallback(async (): Promise<void> => {
    const next = (await api?.appBriefingRead().catch(() => null)) ?? null;
    if (draftRef.current === undefined) setStored(next);
    else setTheirs(next);
  }, [api]);

  useEffect(() => {
    void read();
    return api?.onReferencesChanged?.((event) => {
      if (event.kind === "briefing") void read();
    });
  }, [api, read]);

  const body = stored?.body ?? "";
  const text = draft ?? body;
  const dirty = draft !== undefined && draft !== body;
  // A change that matches what is stored is no conflict.
  const conflict = theirs !== undefined && (theirs?.body ?? "") !== body && dirty;

  // A new text with no real edit in the way simply replaces what is shown.
  useEffect(() => {
    if (theirs === undefined || dirty) return;
    setStored(theirs);
    setTheirs(undefined);
    setDraft(undefined);
  }, [theirs, dirty]);

  const save = async (): Promise<void> => {
    if (!api || !dirty || conflict) return;
    setSaving(true);
    setProblem(undefined);
    const result = await api
      .appBriefingWrite(text)
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }));
    setSaving(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setStored(result.briefing);
    setTheirs(undefined);
    setDraft(undefined);
  };

  return (
    <div className="settings-section texts-settings" data-testid="settings-briefing-section">
      {conflict ? (
        <ChangedElsewhere
          what="The briefing"
          onTakeTheirs={() => {
            setStored(theirs ?? null);
            setTheirs(undefined);
            setDraft(undefined);
          }}
          onKeepMine={() => {
            // The edit now sits on the new text: saving it is a choice made.
            setStored(theirs ?? null);
            setTheirs(undefined);
          }}
        />
      ) : null}
      <Textarea
        className="texts-settings__editor"
        aria-label="App briefing"
        spellCheck={false}
        disabled={stored === undefined}
        placeholder="What every agent should know: how you work, what to avoid, where things are."
        value={text}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="texts-settings__bar">
        <ImportFileButton
          disabled={stored === undefined}
          onImport={(file) => setDraft(appendText(draftRef.current ?? body, file.text))}
        />
        <span className="texts-settings__state" role="status">
          {dirty ? "Not saved" : body.length === 0 ? "" : "Saved"}
        </span>
        {dirty ? (
          <Button variant="subtle" size="md" disabled={saving} onClick={() => setDraft(undefined)}>
            Discard
          </Button>
        ) : null}
        <Button variant="primary" size="md" disabled={!dirty || saving || conflict} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {problem ? (
        <p className="settings-error" role="alert">
          Not saved. {problem}
        </p>
      ) : null}
    </div>
  );
}
