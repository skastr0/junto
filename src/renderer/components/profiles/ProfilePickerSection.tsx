import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { MoreHorizontal, Plus } from "lucide-react";
import {
  PROFILE_NAME_MAX,
  profileSummary,
  type AgentProfile,
  type AgentProfileBody,
} from "@shared/agent-profiles";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import { claimFocus } from "../../lib/focus-ownership";
import {
  deleteProfile,
  ensureProfiles,
  profiles$,
  renameProfile,
} from "../../lib/profiles-state";
import { profileDraft$ } from "../../lib/profile-draft-state";
import { Button, IconButton, Input, Popover } from "../ui";
import { ProfilePortrait } from "./ProfilePortrait";
import "./profiles.css";

/** "Claude, opus, high": the harness by its display name, then its dials. */
export const profileLine = (body: AgentProfileBody): string =>
  profileSummary(body, isHarnessId(body.harness) ? templateFor(body.harness).displayName : body.harness);

const harnessName = (body: AgentProfileBody): string =>
  isHarnessId(body.harness) ? templateFor(body.harness).displayName : body.harness;

/** The dials after the harness: model, effort, mode, or the harness default. */
const dialsLine = (body: AgentProfileBody): string =>
  profileSummary({ ...body, harness: "" }) || "harness default model";

const soulLine = (body: AgentProfileBody): string | undefined =>
  body.soul?.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);

/**
 * Profiles in the add picker, at the node catalog's scale: one card per saved
 * agent (ringed face, name, harness, model, the first line of its soul) and a
 * Create profile card that builds one in the customize editor without a seat.
 * A click on a profile seats it; its menu (or a right-click) renames or
 * deletes it. With a search that matches nothing, the section hides.
 */
export function ProfilePickerSection({
  query,
  onPlace,
  onCreate,
}: {
  readonly query: string;
  readonly onPlace: (profileId: string) => void;
  readonly onCreate: () => void;
}) {
  useEffect(ensureProfiles, []);
  const profiles = use$(profiles$.list);
  const waiting = use$(profileDraft$);
  const [managing, setManaging] = useState<{ readonly profile: AgentProfile; readonly anchor: HTMLElement } | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? profiles.filter((profile) =>
        `${profile.name} ${profileLine(profile)} ${profile.soul ?? ""}`.toLowerCase().includes(needle))
    : profiles;
  const createShown = !needle || "create profile new agent".includes(needle);
  if (shown.length === 0 && !createShown) return null;

  const manage = (profile: AgentProfile, anchor: HTMLElement) => setManaging({ profile, anchor });

  return (
    <section className="profile-picker" aria-label="Profiles">
      <div className="node-deck__pane-label"><span>Profiles</span></div>
      <ul className="profile-picker__list">
        {shown.map((profile) => {
          const soul = soulLine(profile);
          return (
            <li key={profile.profileId} className="profile-picker__item">
              <button
                type="button"
                className="profile-picker__card"
                aria-label={`Place profile ${profile.name}, ${profileLine(profile)}`}
                onClick={() => onPlace(profile.profileId)}
                onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                  manage(profile, event.currentTarget);
                }}
              >
                <ProfilePortrait profileKey={profile.profileId} body={profile} px={52} />
                <span className="profile-picker__text">
                  <span className="profile-picker__name">{profile.name}</span>
                  <span className="profile-picker__launch">
                    <span className="profile-picker__harness">{harnessName(profile)}</span>
                    <span className="profile-picker__dials">{dialsLine(profile)}</span>
                  </span>
                  <span className="profile-picker__soul" data-empty={soul ? undefined : "true"}>
                    {soul ?? "No soul yet"}
                  </span>
                </span>
              </button>
              <IconButton
                aria-label={`Manage profile ${profile.name}`}
                title="Rename or delete"
                className="profile-picker__more"
                onClick={(event) => manage(profile, event.currentTarget)}
              >
                <MoreHorizontal size={14} />
              </IconButton>
            </li>
          );
        })}
        {createShown ? (
          <li className="profile-picker__item">
            <button type="button" className="profile-picker__card profile-picker__create" onClick={onCreate}>
              <span className="profile-picker__slot" aria-hidden>
                <Plus size={20} strokeWidth={1.7} />
              </span>
              <span className="profile-picker__text">
                <span className="profile-picker__name">
                  {waiting ? "Continue profile" : "Create profile"}
                </span>
                <span className="profile-picker__soul">
                  {waiting
                    ? `${waiting.name}, not saved yet.`
                    : "Build an agent to seat later: look, soul, instructions, launch."}
                </span>
              </span>
            </button>
          </li>
        ) : null}
      </ul>
      {managing ? (
        <ProfileManagePopover
          key={managing.profile.profileId}
          profile={managing.profile}
          anchor={managing.anchor}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </section>
  );
}

function ProfileManagePopover({
  profile,
  anchor,
  onClose,
}: {
  readonly profile: AgentProfile;
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    claimFocus(inputRef.current, "open", { select: true });
  }, []);

  const settle = (reason: string): void => {
    if (reason) setError(reason);
    else onClose();
  };

  const rename = async (): Promise<void> => {
    if (name.trim() === profile.name) return onClose();
    settle(await renameProfile(profile.profileId, name));
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Manage profile ${profile.name}`} width={288} testId="profile-manage">
      <form
        className="profile-manage"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Input
          ref={inputRef}
          value={name}
          maxLength={PROFILE_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          aria-label="Profile name"
        />
        <div className="profile-manage__row">
          <Button size="xs" type="submit" disabled={!name.trim()}>Rename</Button>
          {confirmDelete ? (
            <>
              <Button
                size="xs"
                variant="danger"
                onClick={() => void deleteProfile(profile.profileId).then(settle)}
              >
                Delete {profile.name}
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(true)}>Delete profile</Button>
          )}
        </div>
        {error ? <p className="profile-manage__error" role="alert">{error}</p> : null}
      </form>
    </Popover>
  );
}
