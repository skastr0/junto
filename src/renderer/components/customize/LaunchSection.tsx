import { useCallback, useState } from "react";
import type { TextNode } from "@shared/canvas";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  harnessDisplayName,
  performManagedAgentReseat,
  readSkipReseatConfirm,
  writeSkipReseatConfirm,
} from "../../lib/agent-reseat";
import { closeAgentEditor } from "../../lib/agent-editor-state";
import { openSaveProfile } from "../../lib/profiles-state";
import {
  AgentHarnessPick,
  type AgentConfigurationChoices,
} from "../node-palette/AgentHarnessPick";
import { ReseatConfirmDialog } from "../rts/ReseatConfirmDialog";
import { Button } from "../ui";
import type { AgentEditorSectionProps } from "../agent-editor/sections";
import "./customize.css";

// Launch: the harness this seat runs and the model, effort, and mode it
// starts with. Changing any of them re-seats the agent, the same path the
// command card's re-seat takes (stop the process, keep the seat and its
// folder). Also where a configured seat is saved as a profile.

export function LaunchSection({ seat }: AgentEditorSectionProps) {
  const node = seat.node;
  const terminal = node.type === "text" ? node.ether?.terminal : undefined;
  const harness = terminal?.harness && isHarnessId(terminal.harness) ? terminal.harness : undefined;
  const choices = harness ? recoverDocumentLaunchChoices(harness, terminal?.launch) : {};
  const [pending, setPending] = useState<AgentConfigurationChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reseat = useCallback(
    async (next: AgentConfigurationChoices) => {
      if (node.type !== "text") return;
      setBusy(true);
      setError("");
      const result = await performManagedAgentReseat(node as TextNode, next);
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

  const facts: ReadonlyArray<readonly [string, string | undefined]> = [
    ["harness", harness ? templateFor(harness).displayName : terminal?.harness],
    ["profile", choices.profile],
    ["model", choices.model],
    ["effort", choices.effort],
    ["mode", choices.mode],
  ];

  return (
    <div className="customize-launch">
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
            <dt>model</dt>
            <dd className="customize-launch__default">harness default</dd>
          </div>
        ) : null}
      </dl>

      <div className="agent-editor__field">
        <span className="agent-editor__field-label">change</span>
        <AgentHarnessPick
          className="customize-launch__pick"
          listLabel="Harnesses"
          onConfigure={onConfigure}
          {...(harness ? { currentHarness: harness } : {})}
        />
      </div>
      <p className="agent-editor__hint">
        Picking a harness, model, or effort restarts this agent on it. The seat, its folder, look, soul, and
        instructions stay.
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
          onClick={() => {
            closeAgentEditor();
            openSaveProfile(seat.id);
          }}
        >
          Save as profile
        </Button>
      </div>

      {pending ? (
        <ReseatConfirmDialog
          fromLabel={harness ? harnessDisplayName(harness) : "current seat"}
          toLabel={harnessDisplayName(pending.harness)}
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
