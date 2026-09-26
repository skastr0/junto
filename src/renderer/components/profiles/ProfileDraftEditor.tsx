import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import type { TextNode } from "@shared/canvas";
import { ensureProfiles } from "../../lib/profiles-state";
import {
  closeProfileDraft,
  discardProfileDraft,
  profileDraft$,
  profileDraftOpen$,
  saveProfileDraft,
  updateProfileDraft,
  type ProfileDraft,
} from "../../lib/profile-draft-state";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import { state$ } from "../../lib/state";
import { withHarnessSettingsDefaults } from "../node-palette/agent-launch-model";
import { AgentEditor } from "../agent-editor/AgentEditor";
import type { AgentEditorSeat } from "../agent-editor/sections";
import { ProfileSaveActions, useProfileSave } from "./ProfileSaveActions";
import "./profiles.css";

/** Mounted once on the canvas; shows the editor while the draft is open. */
export function ProfileDraftEditorHost() {
  const open = use$(profileDraftOpen$);
  const draft = use$(profileDraft$);
  if (!open || !draft) return null;
  return <ProfileDraftEditor key={draft.id} draft={draft} />;
}

/** A seat-shaped stand-in the editor reads; it never reaches the canvas. */
const draftNode = (draft: ProfileDraft): TextNode => ({
  id: draft.id,
  type: "text",
  text: draft.name,
  x: 0,
  y: 0,
  ...AGENT_NODE_SIZE,
  ether: {
    entity: { kind: "agent", name: draft.name },
    terminal: { bindingId: draft.id, harness: draft.launch.harness, label: draft.name },
  },
});

const draftSeat = (draft: ProfileDraft): AgentEditorSeat => ({
  id: draft.id,
  node: draftNode(draft),
  name: draft.name,
  harness: draft.launch.harness,
  draft: {
    ...(draft.portrait ? { portrait: draft.portrait } : {}),
    setPortrait: (portrait) =>
      updateProfileDraft(({ portrait: _previous, ...rest }) => (portrait ? { ...rest, portrait } : rest)),
    rename: (name) => updateProfileDraft((current) => ({ ...current, name })),
    guidance: draft.guidance,
    setGuidance: (guidance) => updateProfileDraft((current) => ({ ...current, guidance })),
    launch: draft.launch,
    // The same Settings defaults a new agent from the picker gets.
    configure: (choices) =>
      updateProfileDraft((current) => ({
        ...current,
        launch: withHarnessSettingsDefaults(choices, state$.settings.peek()),
      })),
  },
});

/**
 * Create a profile without a seat: the customize editor on a draft (look,
 * mood, name, soul, instructions, launch) with a save row under it. Saving
 * adds the profile to the add picker; nothing lands on the canvas.
 */
function ProfileDraftEditor({ draft }: { readonly draft: ProfileDraft }) {
  useEffect(ensureProfiles, []);
  const save = useProfileSave(draft.name, saveProfileDraft);
  return (
    <AgentEditor
      seat={draftSeat(draft)}
      section="name"
      eyebrow="new profile"
      status="Not on the canvas. Save it to seat it later from Add item."
      onClose={closeProfileDraft}
      footer={
        <div className="profile-draft__foot">
          <ProfileSaveActions state={save} onCancel={discardProfileDraft} cancelLabel="Discard" />
        </div>
      }
    />
  );
}
