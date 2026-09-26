import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { MoreHorizontal } from "lucide-react";
import {
  PROFILE_NAME_MAX,
  profileSummary,
  type AgentProfile,
  type AgentProfileBody,
} from "@shared/agent-profiles";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import { claimFocus } from "../../lib/focus-ownership";
import { isProfileSeat } from "../../lib/agent-profiles";
import {
  deleteProfile,
  ensureProfiles,
  profiles$,
  renameProfile,
  updateProfileFromSeat,
} from "../../lib/profiles-state";
import { state$ } from "../../lib/state";
import { Button, IconButton, Input, Popover } from "../ui";
import { ProfilePortrait } from "./ProfilePortrait";
import "./profiles.css";

/** "Claude, opus, high": the harness by its display name, then its dials. */
export const profileLine = (body: AgentProfileBody): string =>
  profileSummary(body, isHarnessId(body.harness) ? templateFor(body.harness).displayName : body.harness);

/** The one selected agent seat, for "update from seat". */
const selectedSeatId = (): string | undefined => {
  const ids = state$.selectedNodeIds.peek();
  const id = ids.length === 1 ? ids[0] : ids.length === 0 ? state$.selectedNodeId.peek() : undefined;
  if (!id) return undefined;
  return isProfileSeat(state$.doc.peek().nodes.find((node) => node.id === id)) ? id : undefined;
};

/**
 * Profiles in the add picker: one tile per saved agent (ringed face, name,
 * harness line). A click seats it; the tile's menu (or a right-click)
 * renames it, updates it from the selected seat, or deletes it. Hidden while
 * there are no profiles.
 */
export function ProfilePickerSection({
  query,
  onPlace,
}: {
  readonly query: string;
  readonly onPlace: (profileId: string) => void;
}) {
  useEffect(ensureProfiles, []);
  const profiles = use$(profiles$.list);
  const [managing, setManaging] = useState<{ readonly profile: AgentProfile; readonly anchor: HTMLElement } | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? profiles.filter((profile) =>
        `${profile.name} ${profileLine(profile)}`.toLowerCase().includes(needle))
    : profiles;
  if (profiles.length === 0 || shown.length === 0) return null;

  const manage = (profile: AgentProfile, anchor: HTMLElement) => setManaging({ profile, anchor });

  return (
    <section className="profile-picker" aria-label="Profiles">
      <div className="node-deck__pane-label"><span>Profiles</span></div>
      <ul className="profile-picker__list">
        {shown.map((profile) => (
          <li key={profile.profileId} className="profile-picker__item">
            <button
              type="button"
              className="profile-picker__tile"
              aria-label={`Place profile ${profile.name}, ${profileLine(profile)}`}
              title={profile.soul ? profile.soul.split("\n")[0] : undefined}
              onClick={() => onPlace(profile.profileId)}
              onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                event.stopPropagation();
                manage(profile, event.currentTarget);
              }}
            >
              <ProfilePortrait profileKey={profile.profileId} body={profile} px={36} />
              <span className="profile-picker__text">
                <span className="profile-picker__name">{profile.name}</span>
                <small className="profile-picker__meta">{profileLine(profile)}</small>
              </span>
            </button>
            <IconButton
              aria-label={`Manage profile ${profile.name}`}
              title="Rename, update, or delete"
              className="profile-picker__more"
              onClick={(event) => manage(profile, event.currentTarget)}
            >
              <MoreHorizontal size={13} />
            </IconButton>
          </li>
        ))}
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
  const seatId = selectedSeatId();

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
          <Button
            size="xs"
            disabled={!seatId}
            title={seatId ? "Replace this profile with the selected seat" : "Select one agent seat on the canvas first"}
            onClick={() => {
              if (seatId) void updateProfileFromSeat(profile.profileId, seatId).then(settle);
            }}
          >
            Update from seat
          </Button>
        </div>
        <div className="profile-manage__row">
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
