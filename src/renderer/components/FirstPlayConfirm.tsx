import { Play } from "lucide-react";
import { ConfirmDialog } from "./ui";

// First-play confirmation — the explicit operator gate the pause law requires
// (@shared/pause: the crew is BORN PAUSED; the first play is a human
// decision, never a default). Shown once per canvas (everPlayed latch);
// subsequent play/pause toggles are direct.

/** What play actually does — honest consequences, no softeners. */
const CONSEQUENCES: ReadonlyArray<string> = [
  "Cron and relay nodes start firing, and may spend real agent turns.",
  "Agents can act through the Junto CLI.",
  "Queued messages deliver to their targets.",
  "Queued tasks are handed to free connected agents.",
];

export function FirstPlayConfirm({
  canvasName,
  onConfirm,
  onCancel,
}: {
  readonly canvasName: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      eyebrow="first play"
      title={<>Start “{canvasName}”?</>}
      tone="primary"
      confirmLabel={
        <>
          <Play size={11} />
          Play
        </>
      }
      testId="first-play-confirm"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>This canvas has never run. Once playing, it acts on its own:</p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {CONSEQUENCES.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="text-amber">—</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <p className="text-dim">Pausing is always instant and needs no confirmation.</p>
    </ConfirmDialog>
  );
}
