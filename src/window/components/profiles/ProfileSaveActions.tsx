import { useState } from "react";
import { use$ } from "@legendapp/state/react";
import { profileNamed } from "@shared/agent-profiles";
import { profiles$ } from "../../lib/profiles-state";
import { Button } from "../ui";
import "./profiles.css";

export type ProfileSave = {
  /** Save under the name; asks first when a profile already has it. */
  readonly submit: () => Promise<void>;
  /** The profile a save would replace, once the operator was asked. */
  readonly replacing: string | undefined;
  readonly back: () => void;
  readonly error: string;
  readonly clearError: () => void;
  readonly saving: boolean;
};

/**
 * One save under a profile name. A name that already belongs to a profile
 * does not save on the first press: the row asks, inline, whether to replace
 * it, and the second press does. Changing the name drops the question.
 */
export const useProfileSave = (
  name: string,
  save: (replaceId?: string) => Promise<string>,
): ProfileSave => {
  const profiles = use$(profiles$.list);
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const existing = name.trim() ? profileNamed(profiles, name) : undefined;
  const replacing = existing && asked === existing.profileId ? existing : undefined;

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (!name.trim()) {
      setError("give the profile a name");
      return;
    }
    if (existing && !replacing) {
      setAsked(existing.profileId);
      return;
    }
    setSaving(true);
    const reason = await save(replacing?.profileId);
    setSaving(false);
    setError(reason);
  };

  return {
    submit,
    replacing: replacing?.name,
    back: () => setAsked(undefined),
    error,
    clearError: () => setError(""),
    saving,
  };
};

/** The save row: the replace question when it is asked, then the buttons. */
export function ProfileSaveActions({
  state,
  disabled = false,
  onCancel,
  cancelLabel = "Cancel",
  submit = "button",
}: {
  readonly state: ProfileSave;
  readonly disabled?: boolean;
  readonly onCancel: () => void;
  readonly cancelLabel?: string;
  /** "submit" when a surrounding form's Enter should save. */
  readonly submit?: "button" | "submit";
}) {
  const { replacing } = state;
  return (
    <div className="profile-save">
      {state.error ? <p className="profile-save__error" role="alert">{state.error}</p> : null}
      {replacing ? (
        <p className="profile-save__ask" role="status">
          <strong>{replacing}</strong> is already a profile. Replace it with this one, or go back and choose
          another name.
        </p>
      ) : null}
      <div className="profile-save__buttons">
        {replacing ? (
          <Button variant="subtle" onClick={state.back}>Back</Button>
        ) : (
          <Button variant="subtle" onClick={onCancel}>{cancelLabel}</Button>
        )}
        <Button
          variant={replacing ? "danger" : "primary"}
          type={submit}
          disabled={disabled || state.saving}
          {...(submit === "button" ? { onClick: () => void state.submit() } : {})}
        >
          {replacing ? `Replace ${replacing}` : "Save profile"}
        </Button>
      </div>
    </div>
  );
}
