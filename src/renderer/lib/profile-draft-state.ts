/**
 * A profile being built in the customize editor before any seat exists
 * ("Create profile" in the add picker): name, character, launch, soul, and
 * instructions, held here in memory. Nothing is stored until it is saved as
 * a profile, and no node is ever made. Closing the editor keeps the draft for
 * the next "Create profile"; saving or discarding it ends it.
 */
import { observable } from "@legendapp/state";
import { decodeProfileBody, type AgentProfileBody } from "@shared/agent-profiles";
import type { PortraitConfig } from "@shared/agent-portrait";
import { managedHarnessEnabled } from "@shared/features";
import { HARNESS_IDS, type HarnessId } from "@shared/managed-terminal-templates";
import type { SeatGuidance } from "@shared/seat-guidance";
import { resolvedPortrait } from "./agent-profiles";
import { saveProfileBody } from "./profiles-state";

/** How a draft launches: the harness and its dials, as the picker reports them. */
export type ProfileDraftLaunch = {
  readonly harness: HarnessId;
  /** Hermes profile the harness runs as. */
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly permissionMode?: string;
};

export type ProfileDraft = {
  /** Identity the draft's born face is drawn from; never a node id. */
  readonly id: string;
  readonly name: string;
  readonly launch: ProfileDraftLaunch;
  /** The operator's character override so far. */
  readonly portrait?: PortraitConfig;
  readonly guidance: SeatGuidance;
};

export const profileDraft$ = observable<ProfileDraft | null>(null);
/** Whether the editor shows the draft; a closed draft waits in memory. */
export const profileDraftOpen$ = observable(false);

export const DRAFT_NAME = "New agent";

/** Claude Code when this build runs it, else the first harness it does. */
const firstHarness = (): HarnessId =>
  (managedHarnessEnabled("claude") ? "claude" : HARNESS_IDS.find(managedHarnessEnabled)) ?? "claude";

let drafts = 0;

/** Open the editor on the waiting draft, or on a new one. */
export const openProfileDraft = (): void => {
  if (!profileDraft$.peek()) {
    drafts += 1;
    profileDraft$.set({
      id: `profile-draft-${Date.now().toString(36)}-${drafts}`,
      name: DRAFT_NAME,
      launch: { harness: firstHarness() },
      guidance: {},
    });
  }
  profileDraftOpen$.set(true);
};

/** Close the editor; the draft waits for the next open. */
export const closeProfileDraft = (): void => {
  profileDraftOpen$.set(false);
};

export const discardProfileDraft = (): void => {
  profileDraftOpen$.set(false);
  profileDraft$.set(null);
};

/** Apply one change to the draft; a no-op once it was saved or discarded. */
export const updateProfileDraft = (change: (draft: ProfileDraft) => ProfileDraft): void => {
  const draft = profileDraft$.peek();
  if (draft) profileDraft$.set(change(draft));
};

/** The draft as a profile body: the face resolved so a seat's new id draws it. */
export const profileDraftBody = (draft: ProfileDraft): AgentProfileBody | null => {
  const { launch } = draft;
  return decodeProfileBody({
    name: draft.name,
    harness: launch.harness,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort ? { effort: launch.effort } : {}),
    ...(launch.mode ? { mode: launch.mode } : {}),
    ...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}),
    ...(launch.profile ? { harnessProfile: launch.profile } : {}),
    portrait: resolvedPortrait(draft.id, draft.portrait),
    ...(draft.guidance.soul ? { soul: draft.guidance.soul } : {}),
    ...(draft.guidance.instructions ? { instructions: draft.guidance.instructions } : {}),
  });
};

/**
 * Save the draft as a new profile, or over `replaceId`. Resolves "" and ends
 * the draft on success, else the reason and the draft stays open.
 */
export const saveProfileDraft = async (replaceId?: string): Promise<string> => {
  const draft = profileDraft$.peek();
  if (!draft) return "nothing to save";
  const body = profileDraftBody(draft);
  if (!body) return "give the profile a name";
  const reason = await saveProfileBody(body, replaceId);
  if (!reason) discardProfileDraft();
  return reason;
};
