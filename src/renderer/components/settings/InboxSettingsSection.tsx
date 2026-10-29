/**
 * Settings -> Inbox (11 Q4): the Artifacts node this canvas's quick captures
 * land in. It belongs to the canvas in front of you and to this machine; the
 * first Cmd+T on a canvas with none asks the same question. Picking a node
 * changes where new captures go; captures already made stay where they are.
 */
import { use$ } from "@legendapp/state/react";
import { titleAt } from "../../lib/use-model";
import { setCaptureInbox, useCaptureInbox } from "../../lib/capture-inbox";
import { state$ } from "../../lib/state";
import { CaptureInboxPicker } from "../capture/CaptureInboxPicker";
import { Button } from "../ui";
import { SettingBlock } from "./FieldRow";

export function InboxSettingsSection() {
  const canvasName = use$(state$.canvasName);
  const inbox = useCaptureInbox(canvasName);
  return (
    <div className="settings-section settings-blocks">
      <SettingBlock
        label="Inbox"
        hint={
          inbox === undefined
            ? `Cmd+T captures on ${canvasName} have no home yet. Pick an Artifacts node, or make one.`
            : `Cmd+T captures on ${canvasName} land in ${titleAt(canvasName, inbox)}. Captures already made stay where they are.`
        }
      >
        {() => (
          <>
            <CaptureInboxPicker
              canvasName={canvasName}
              value={inbox}
              label="Artifacts node for captures"
              onPick={(nodeId) => setCaptureInbox(canvasName, nodeId)}
            />
            {inbox === undefined ? null : (
              <div>
                <Button variant="chrome" onClick={() => setCaptureInbox(canvasName, null)}>
                  Ask again on the next capture
                </Button>
              </div>
            )}
          </>
        )}
      </SettingBlock>
    </div>
  );
}
