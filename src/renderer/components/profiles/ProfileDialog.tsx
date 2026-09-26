import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import { PROFILE_NAME_MAX, profileNamed, type AgentProfile } from "@shared/agent-profiles";
import { claimFocus } from "../../lib/focus-ownership";
import {
  captureSeatProfile,
  closeSaveProfile,
  ensureProfiles,
  profileDialog$,
  profiles$,
  saveProfileFromSeat,
} from "../../lib/profiles-state";
import { Button, Combobox, FieldLabel, IconButton, OverlayHeader } from "../ui";
import { FocusSurface } from "../FocusSurface";
import { ProfilePortrait } from "./ProfilePortrait";
import { profileLine } from "./ProfilePickerSection";
import "./profiles.css";

/** Mounted once on the canvas; shows the dialog while one is requested. */
export function ProfileDialogHost() {
  const request = use$(profileDialog$);
  if (!request) return null;
  return (
    <ProfileDialog
      key={`${request.profileId ?? "new"}|${request.seatId}`}
      seatId={request.seatId}
      {...(request.profileId ? { replaceId: request.profileId } : {})}
    />
  );
}

/**
 * Save one agent seat as a profile: its name, character, harness with model
 * and effort, and its soul and instructions. Typing an existing profile's
 * name (or picking it) replaces that profile.
 */
function ProfileDialog({ seatId, replaceId }: { readonly seatId: string; readonly replaceId?: string }) {
  useEffect(ensureProfiles, []);
  const profiles = use$(profiles$.list);
  const captured = useMemo(() => captureSeatProfile(seatId), [seatId]);
  const replacing = profiles.find((profile) => profile.profileId === replaceId);
  const [name, setName] = useState(replacing?.name ?? captured?.name ?? "");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);

  const target = name.trim() ? profileNamed(profiles, name) : undefined;
  const matches = profiles.filter((profile) =>
    name.trim() === "" ? true : profile.name.toLowerCase().includes(name.trim().toLowerCase()),
  );
  const completion = name.trim()
    ? profiles.find((profile) => profile.name.toLowerCase().startsWith(name.toLowerCase()))?.name
    : undefined;

  const save = async (): Promise<void> => {
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("give the profile a name");
      return;
    }
    setSaving(true);
    const reason = await saveProfileFromSeat({
      seatId,
      name: trimmed,
      ...(target ? { profileId: target.profileId } : {}),
    });
    setSaving(false);
    if (reason) setError(reason);
    else closeSaveProfile();
  };

  const choose = (profile: AgentProfile): void => {
    setName(profile.name);
    claimFocus(saveRef.current, "gesture");
  };

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
        title={target ? `Replace ${target.name}` : "Save as profile"}
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
          void save();
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
          <Combobox<AgentProfile>
            value={name}
            onValueChange={(value) => {
              setName(value.slice(0, PROFILE_NAME_MAX));
              setError("");
            }}
            {...(completion ? { completion } : {})}
            options={matches}
            optionKey={(profile) => profile.profileId}
            renderOption={(profile) => (
              <span className="profile-dialog__option">
                <ProfilePortrait profileKey={profile.profileId} body={profile} px={22} />
                <span className="profile-dialog__option-name">{profile.name}</span>
                <small>{profileLine(profile)}, replace</small>
              </span>
            )}
            activeKey={active}
            onActiveKeyChange={setActive}
            {...(target ? { selectedKey: target.profileId } : {})}
            onCommit={(option, value) => {
              if (option) choose(option);
              else {
                setName(value);
                void save();
              }
            }}
            onOptionClick={choose}
            aria-label="Profile name"
            listLabel="Existing profiles"
            placeholder="Reviewer"
            empty={<span className="profile-dialog__hint">No profiles yet. This one is the first.</span>}
          />
          <small className="profile-dialog__hint">
            {target ? `Saving replaces ${target.name}.` : "Pick an existing profile to replace it."}
          </small>
        </div>

        {error ? <p className="profile-dialog__error" role="alert">{error}</p> : null}

        <div className="profile-dialog__actions">
          <Button variant="subtle" onClick={closeSaveProfile}>Cancel</Button>
          <Button ref={saveRef} variant="primary" type="submit" disabled={!captured || saving}>
            {target ? "Replace profile" : "Save profile"}
          </Button>
        </div>
      </form>
    </FocusSurface>
  );
}
