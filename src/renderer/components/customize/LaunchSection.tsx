import { useCallback, useState } from "react";
import type { TextNode } from "@shared/canvas";
import { nodeToDocument } from "@shared/model/from-document";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  harnessDisplayName,
  performManagedAgentReseat,
  readSkipReseatConfirm,
  writeSkipReseatConfirm,
} from "../../lib/agent-reseat";
import { openSaveProfile } from "../../lib/profiles-state";
import {
  AgentHarnessPick,
  type AgentConfigurationChoices,
} from "../node-palette/AgentHarnessPick";
import { ReseatConfirmDialog } from "../rts/ReseatConfirmDialog";
import { Button } from "../ui";
import type { AgentEditorDraft, AgentEditorSectionProps } from "../agent-editor/sections";
import "./customize.css";

// Launch: the harness this seat runs and the model, effort, and mode it
// starts with. Changing any of them re-seats the agent, the same path the
// command card's re-seat takes (stop the process, keep the seat and its
// folder). Also where a configured seat is saved as a profile. A profile
// being created has no process: picking only sets what its seats start on.

export function LaunchSection({ seat }: AgentEditorSectionProps) {
  return seat.draft ? <DraftLaunch draft={seat.draft} /> : <SeatLaunch seat={seat} />;
}

type LaunchChoices = Omit<AgentConfigurationChoices, "harness">;

/** What the agent starts with, as a short definition list. */
function LaunchFacts({ harness, choices }: { readonly harness: string | undefined; readonly choices: LaunchChoices }) {
  const facts: ReadonlyArray<readonly [string, string | undefined]> = [
    ["harness", harness && isHarnessId(harness) ? templateFor(harness).displayName : harness],
    ["profile", choices.profile],
    ["model", choices.model],
    ["effort", choices.effort],
    ["mode", choices.mode],
  ];
  return (
    <dl className="customize-launch__facts" aria-label="How this agent starts">
      {facts
        .filter((fact): fact is readonly [string, string] => Boolean(fact[1]))
        .map(([term, value]) => (
          <div key={term} className="customize-launch__fact">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      {!choices.model && !choices.effort && !choices.mode ? (
        <div className="customize-launch__fact">
          <dt>{harness === "amp" ? "mode" : "model"}</dt>
          <dd className="customize-launch__default">harness default</dd>
        </div>
      ) : null}
    </dl>
  );
}

function DraftLaunch({ draft }: { readonly draft: AgentEditorDraft }) {
  const { harness, ...choices } = draft.launch;
  return (
    <div className="customize-launch">
      <LaunchFacts harness={harness} choices={choices} />
      <div className="agent-editor__field">
        <span className="agent-editor__field-label">change</span>
        <AgentHarnessPick
          className="customize-launch__pick"
          listLabel="Harnesses"
          onConfigure={draft.configure}
          currentHarness={harness}
        />
      </div>
      <p className="agent-editor__hint">
        {harness === "amp"
          ? "Every seat made from this profile starts in the selected Amp mode. The folder comes from wherever you place it."
          : "Every seat made from this profile starts on this harness, model, and effort. The folder comes from wherever you place it."}
      </p>
    </div>
  );
}

function SeatLaunch({ seat }: AgentEditorSectionProps) {
  const node = seat.node;
  const harness = node && isHarnessId(node.harness) ? node.harness : undefined;
  const choices = harness ? recoverDocumentLaunchChoices(harness, node?.launch) : {};
  const [pending, setPending] = useState<AgentConfigurationChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reseat = useCallback(
    async (next: AgentConfigurationChoices) => {
      if (!node) return;
      setBusy(true);
      setError("");
      // The re-seat writer still takes the document form of a seat.
      const result = await performManagedAgentReseat(nodeToDocument(node) as TextNode, next);
      setBusy(false);
      setPending(null);
      if (!result.ok) setError(result.message);
    },
    [node],
  );

  const onConfigure = useCallback(
    (next: AgentConfigurationChoices) => {
      if (readSkipReseatConfirm()) void reseat(next);
      else setPending(next);
    },
    [reseat],
  );

  return (
    <div className="customize-launch">
      <LaunchFacts harness={node?.harness} choices={choices} />

      <div className="agent-editor__field">
        <span className="agent-editor__field-label">change</span>
        <AgentHarnessPick
          className="customize-launch__pick"
          listLabel="Harnesses"
          cwd={node?.launch?.cwd}
          onConfigure={onConfigure}
          {...(harness ? { currentHarness: harness } : {})}
        />
      </div>
      <p className="agent-editor__hint">
        {harness === "amp"
          ? "Choosing an Amp mode creates a new thread for this seat. The seat, folder, look, soul, and instructions stay."
          : "Picking a harness, model, or effort restarts this agent on it. The seat, its folder, look, soul, and instructions stay."}
      </p>
      {busy ? <p className="agent-editor__hint" role="status">Re-seating…</p> : null}
      {error ? <p className="customize-guidance__error" role="alert">{error}</p> : null}

      <div className="customize-launch__profile">
        <div>
          <span className="customize-launch__profile-title">Save as profile</span>
          <p className="agent-editor__hint">
            Keep this name, look, launch, soul, and instructions to seat again in any project.
          </p>
        </div>
        <Button
          size="sm"
          className="customize-launch__save"
          onClick={() => openSaveProfile(seat.id)}
        >
          Save as profile
        </Button>
      </div>

      {pending ? (
        <ReseatConfirmDialog
          fromLabel={harness ? harnessDisplayName(harness) : "current seat"}
          toLabel={pending.mode
            ? `${harnessDisplayName(pending.harness)} (${pending.mode})`
            : harnessDisplayName(pending.harness)}
          onCancel={() => setPending(null)}
          onConfirm={(dontShowAgain) => {
            if (dontShowAgain) writeSkipReseatConfirm(true);
            void reseat(pending);
          }}
        />
      ) : null}
    </div>
  );
}
