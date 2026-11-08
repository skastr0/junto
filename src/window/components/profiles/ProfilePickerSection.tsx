import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  PROFILE_NAME_MAX,
  profileSummary,
  type AgentProfile,
  type AgentProfileBody,
} from "@shared/agent-profiles";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  deleteProfile,
  ensureProfiles,
  profiles$,
  renameProfile,
} from "../../lib/profiles-state";
import { profileDraft$ } from "../../lib/profile-draft-state";
import { PickerCard, PickerCardAddArt, PickerCardGrid, PickerCardManage } from "../ui";
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
 * Profiles in the add picker: one card per saved agent (ringed face, name,
 * harness, model, the first line of its soul) and a Create profile card that
 * builds one in the customize editor without a seat. A click on a profile
 * seats it; its menu (or a right-click) renames or deletes it. With a search
 * that matches nothing, the section hides.
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

  return (
    <section className="profile-picker" aria-label="Profiles">
      <div className="node-deck__pane-label"><span>Profiles</span></div>
      <PickerCardGrid>
        {shown.map((profile) => {
          const soul = soulLine(profile);
          return (
            <PickerCard
              key={profile.profileId}
              kind="profile"
              art={<ProfilePortrait profileKey={profile.profileId} body={profile} px={48} />}
              title={profile.name}
              lead={harnessName(profile)}
              meta={dialsLine(profile)}
              body={soul ?? "No soul yet"}
              quiet={!soul}
              label={`Place profile ${profile.name}, ${profileLine(profile)}`}
              onActivate={() => onPlace(profile.profileId)}
              menu={{
                label: `Manage profile ${profile.name}`,
                title: "Rename or delete",
                onOpen: (anchor) => setManaging({ profile, anchor }),
              }}
            />
          );
        })}
        {createShown ? (
          <PickerCard
            kind="create"
            art={<PickerCardAddArt />}
            title={waiting ? "Continue profile" : "Create profile"}
            body={waiting
              ? `${waiting.name}, not saved yet.`
              : "Build an agent to seat later: look, soul, instructions, launch."}
            onActivate={onCreate}
          />
        ) : null}
      </PickerCardGrid>
      {managing ? (
        <PickerCardManage
          key={managing.profile.profileId}
          noun="profile"
          name={managing.profile.name}
          maxLength={PROFILE_NAME_MAX}
          anchor={managing.anchor}
          onClose={() => setManaging(null)}
          onRename={(name) => renameProfile(managing.profile.profileId, name)}
          onDelete={() => deleteProfile(managing.profile.profileId)}
          testId="profile-manage"
        />
      ) : null}
    </section>
  );
}
