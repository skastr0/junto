/**
 * Renderer mirror of the operator's agent profiles plus the profile actions:
 * save a seat as a profile, update one from a seat, rename, delete, and place
 * one on the canvas as a fresh seat. Main owns `agent_profiles`; every change
 * comes back as the full list.
 */
import { observable } from "@legendapp/state";
import type { AgentProfile, AgentProfileBody } from "@shared/agent-profiles";
import { findContainingRegion, resolveRegionCwd } from "@shared/region-defaults";
import { AGENT_NODE_SIZE } from "./node-geometry";
import { getJuntoApi } from "./junto-api";
import { addNode } from "./mutations";
import { profileBodyFromSeat, seatFromProfile } from "./agent-profiles";
import { saveSeatGuidances, saveSquadPortraits, squadPortraitOf } from "./squad-portraits";
import { seatGuidanceOf, startSeatGuidance } from "./seat-guidance-state";
import type { PlaceOutcome } from "./squads-state";
import type { SquadLaunch } from "./squads";
import { state$ } from "./state";

export const profiles$ = observable({
  list: [] as ReadonlyArray<AgentProfile>,
  hydrated: false,
});

/** The save-as-profile dialog, when open: the seat it saves and the profile it replaces. */
export const profileDialog$ = observable<{
  readonly seatId: string;
  readonly profileId?: string;
} | null>(null);

export const openSaveProfile = (seatId: string, profileId?: string): void => {
  profileDialog$.set({ seatId, ...(profileId ? { profileId } : {}) });
};

export const closeSaveProfile = (): void => {
  profileDialog$.set(null);
};

let started = false;

/** Idempotent: hydrate once and follow every change main pushes. */
export const ensureProfiles = (): void => {
  // Capturing a seat reads its soul and instructions from this store.
  startSeatGuidance();
  if (started) return;
  const api = getJuntoApi();
  if (!api?.profilesList) return;
  started = true;
  api.onProfilesChanged?.((list) => profiles$.assign({ list, hydrated: true }));
  void api
    .profilesList()
    .then((list) => profiles$.assign({ list, hydrated: true }))
    .catch(() => {
      started = false;
    });
};

const adopt = (profile: AgentProfile): void => {
  const others = profiles$.list.peek().filter((entry) => entry.profileId !== profile.profileId);
  profiles$.list.set(
    [...others, profile].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );
};

/** One seat captured as a profile body, from the open canvas and the saved stores. */
export const captureSeatProfile = (seatId: string): AgentProfileBody | null =>
  profileBodyFromSeat(
    state$.doc.peek().nodes.find((node) => node.id === seatId),
    { portraitOf: squadPortraitOf, guidanceOf: seatGuidanceOf },
  );

export type SaveProfileInput = {
  readonly seatId: string;
  /** The profile's name; defaults to the seat's name. */
  readonly name?: string;
  /** Replace this profile instead of creating one. */
  readonly profileId?: string;
};

/** Save a seat as a profile. Resolves "" on success, else the reason. */
export const saveProfileFromSeat = async (input: SaveProfileInput): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.profileSave) return "profiles are unavailable";
  const captured = captureSeatProfile(input.seatId);
  if (!captured) return "only an agent seat can be saved as a profile";
  const name = input.name?.trim();
  const result = await api.profileSave({
    ...(input.profileId ? { profileId: input.profileId } : {}),
    body: name ? { ...captured, name } : captured,
  });
  if (!result.ok) return result.message;
  adopt(result.profile);
  return "";
};

/** Replace a profile's configuration with a seat's, keeping its name. */
export const updateProfileFromSeat = async (profileId: string, seatId: string): Promise<string> => {
  const profile = profiles$.list.peek().find((entry) => entry.profileId === profileId);
  if (!profile) return "that profile no longer exists";
  return saveProfileFromSeat({ seatId, profileId, name: profile.name });
};

export const renameProfile = async (profileId: string, name: string): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.profileRename) return "profiles are unavailable";
  const result = await api.profileRename(profileId, name);
  if (!result.ok) return result.message;
  adopt(result.profile);
  return "";
};

export const deleteProfile = async (profileId: string): Promise<string> => {
  const api = getJuntoApi();
  if (!api?.profileDelete) return "profiles are unavailable";
  const result = await api.profileDelete(profileId);
  if (!result.ok) return result.message;
  profiles$.list.set(profiles$.list.peek().filter((entry) => entry.profileId !== profileId));
  return "";
};

/**
 * Place a profile as a fresh seat where the add flow would put an agent: the
 * right-click point, or the next open slot. Inside a region with a default
 * folder for the host the seat works there, else in the launch folder; with
 * neither it asks for a folder instead of minting a seat that cannot start.
 */
export const placeProfileInSlot = async (
  profileId: string,
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
  launch: SquadLaunch,
): Promise<PlaceOutcome> => {
  const profile = profiles$.list.peek().find((entry) => entry.profileId === profileId);
  if (!profile) return "failed";
  const doc = state$.doc.peek();
  const at = positionFor(AGENT_NODE_SIZE);
  const center = { x: at.x + AGENT_NODE_SIZE.width / 2, y: at.y + AGENT_NODE_SIZE.height / 2 };
  const regionCwd = findContainingRegion(doc, center.x, center.y)
    ? resolveRegionCwd(doc, center.x, center.y, launch.host)
    : undefined;
  const cwd = regionCwd ?? launch.cwd;
  if (!cwd) return "needs-folder";
  const placed = seatFromProfile(profile, {
    x: at.x,
    y: at.y,
    host: launch.host,
    ...(launch.agentHost ? { agentHost: launch.agentHost } : {}),
    cwd,
  });
  if (!placed.ok) {
    state$.error.set(placed.message);
    return "failed";
  }
  addNode(placed.node, { edit: false });
  state$.focusNodeId.set(placed.node.id);
  const problems: string[] = [];
  if (placed.portrait && !(await saveSquadPortraits({ [placed.node.id]: placed.portrait }))) {
    problems.push("portrait not copied");
  }
  if (placed.guidance && !(await saveSeatGuidances({ [placed.node.id]: placed.guidance }))) {
    problems.push("soul and instructions not copied");
  }
  if (problems.length > 0) state$.error.set(`${profile.name}: ${problems.join(", ")}`);
  return "placed";
};
