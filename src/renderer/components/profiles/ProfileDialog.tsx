import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import { PROFILE_NAME_MAX } from "@shared/agent-profiles";
import { claimFocusAndSelectOnMount } from "../../lib/focus-ownership";
import {
  captureSeatProfile,
  closeSaveProfile,
  ensureProfiles,
  profileDialog$,
  saveProfileFromSeat,
} from "../../lib/profiles-state";
import { FieldLabel, IconButton, Input, OverlayHeader } from "../ui";
import { FocusSurface } from "../FocusSurface";
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

  const includes = captured
    ? [
        "character",
        profileLine(captured),
        ...(captured.soul ? ["soul"] : []),
        ...(captured.instructions ? ["instructions"] : []),
      ]
    : [];

  return (
    <FocusSurface measure="form" height="fit" layer="work" label="Save as profile" onClose={closeSaveProfile}>
      <OverlayHeader
        eyebrow="Profile"
        title="Save as profile"
        status={captured ? includes.join(", ") : "not an agent seat"}
        actions={
          <IconButton aria-label="Close save as profile" title="Close" onClick={closeSaveProfile}>
            <X size={14} />
          </IconButton>
        }
      />
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
        ) : null}

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
    </FocusSurface>
  );
}
