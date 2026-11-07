import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PROFILE_NAME_MAX } from "@shared/agent-profiles";
import { claimFocusAndSelectOnMount } from "../../lib/focus-ownership";
import {
  captureSeatProfile,
  closeSaveProfile,
  ensureProfiles,
  profileDialog$,
  saveProfileFromSeat,
} from "../../lib/profiles-state";
import { Dialog, FieldLabel, Input } from "../ui";
import { ProfilePortrait } from "./ProfilePortrait";
import { profileLine } from "./ProfilePickerSection";
import { ProfileSaveActions, useProfileSave } from "./ProfileSaveActions";
import "./profiles.css";

/** Mounted once on the canvas; shows the dialog while one is requested. */
export function ProfileDialogHost() {
  const request = use$(profileDialog$);
  if (!request) return null;
  return <ProfileDialog key={request.seatId} seatId={request.seatId} />;
}

/**
 * Save one agent seat as a profile: its name, character, harness with model
 * and effort, and its soul and instructions. A name another profile already
 * has asks, inline, before it replaces that profile.
 */
function ProfileDialog({ seatId }: { readonly seatId: string }) {
  useEffect(ensureProfiles, []);
  const captured = useMemo(() => captureSeatProfile(seatId), [seatId]);
  const [name, setName] = useState(captured?.name ?? "");
  const save = useProfileSave(name, async (replaceId) => {
    const reason = await saveProfileFromSeat({
      seatId,
      name: name.trim(),
      ...(replaceId ? { profileId: replaceId } : {}),
    });
    if (!reason) closeSaveProfile();
    return reason;
  });

  return (
    <Dialog eyebrow="Profile" title="Save as profile" onClose={closeSaveProfile}>
      <form
        className="profile-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save.submit();
        }}
      >
        {captured ? (
          <div className="profile-dialog__preview">
            <ProfilePortrait profileKey={`draft-${seatId}`} body={captured} px={56} />
            <div className="profile-dialog__facts">
              <span className="profile-dialog__who">{captured.name}</span>
              <span className="profile-dialog__line">{profileLine(captured)}</span>
              <span className="profile-dialog__hint">
                {captured.soul || captured.instructions
                  ? `With its ${[captured.soul ? "soul" : "", captured.instructions ? "instructions" : ""].filter(Boolean).join(" and ")}.`
                  : "No soul or instructions yet; add them in Customize."}
              </span>
            </div>
          </div>
        ) : (
          <p className="profile-dialog__line">not an agent seat</p>
        )}

        <div className="profile-dialog__field">
          <FieldLabel>Name</FieldLabel>
          <Input
            ref={claimFocusAndSelectOnMount}
            value={name}
            maxLength={PROFILE_NAME_MAX}
            spellCheck={false}
            placeholder="Reviewer"
            aria-label="Profile name"
            onChange={(event) => {
              setName(event.target.value);
              save.back();
              save.clearError();
            }}
          />
        </div>

        <ProfileSaveActions state={save} submit="submit" disabled={!captured} onCancel={closeSaveProfile} />
      </form>
    </Dialog>
  );
}
