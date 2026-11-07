import { setCaptureInbox } from "../../lib/capture-inbox";
import { CaptureInboxPicker } from "./CaptureInboxPicker";
import "./capture-inbox.css";

/**
 * The one-time ask on the first Cmd+T of a canvas with no Inbox (11 Q4).
 * It fills the pane the capture editor would, so the surface's search and
 * previews stay usable while the operator decides. A pick, or Make an Inbox,
 * sets the canvas's Inbox through `setCaptureInbox` and then calls
 * `onChosen`; the surface turns the pane into the editor and focuses it.
 */
export function CaptureInboxAsk({
  canvas,
  onChosen,
}: {
  readonly canvas: string;
  readonly onChosen: (nodeId: string) => void;
}) {
  return (
    <section className="capture-inbox-ask" aria-labelledby="capture-inbox-ask-title">
      <h2 id="capture-inbox-ask-title" className="capture-inbox-ask__title">
        Where do captures go?
      </h2>
      <p className="capture-inbox-ask__body">
        Pick the Artifacts node your captures land in. You can change it later in Settings, under Inbox.
      </p>
      <CaptureInboxPicker
        canvasName={canvas}
        value={undefined}
        label="Artifacts node for captures"
        onPick={(nodeId) => {
          setCaptureInbox(canvas, nodeId);
          onChosen(nodeId);
        }}
      />
    </section>
  );
}
