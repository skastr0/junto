import { useEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { closeOperatorModal } from "../../lib/operator-modal";
import { state$ } from "../../lib/state";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { QuickThread } from "./QuickThread";

/**
 * Quick thread's home on the canvas: a small frame near the top, as the
 * command bar sits, that opens from anywhere on its key. No title: the seat
 * picker is the top. Escape and a press outside close it, and what was not
 * sent (seats, text, files) is there on the next open. Once every seat has
 * its thread it closes; the close is the confirmation. A seat the mail has
 * not reached yet is not left unsaid: the frame turns into a receipt that
 * names it, until Done.
 */
export function QuickThreadModal() {
  const canvasName = use$(state$.canvasName);
  const backOut = useRef<(() => boolean) | null>(null);
  // No canvas, nobody to write to.
  useEffect(() => {
    if (canvasName === "") closeOperatorModal("quick-thread");
  }, [canvasName]);
  if (canvasName === "") return null;
  return (
    <OperatorModalShell
      id="quick-thread"
      label="Quick thread"
      width={560}
      panelClassName="quick-thread-modal"
      onEscape={() => backOut.current?.() === true}
    >
      <QuickThread canvasName={canvasName} receipt backOut={backOut} onSent={() => closeOperatorModal("quick-thread")} />
    </OperatorModalShell>
  );
}
