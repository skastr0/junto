import { use$ } from "@legendapp/state/react";
import { answerConfirm, confirm$ } from "../lib/confirm";
import { ConfirmDialog } from "./ui";

/**
 * Renders the pending askConfirm question as the working dialog. Mounted
 * once; any code, React or not, asks through lib/confirm.
 */
export function ConfirmHost() {
  const pending = use$(confirm$.pending);
  if (!pending) return null;
  return (
    <ConfirmDialog
      title={pending.title}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      tone={pending.tone ?? "danger"}
      testId="confirm-dialog"
      onConfirm={() => answerConfirm(true)}
      onCancel={() => answerConfirm(false)}
    >
      {pending.body && pending.body.length > 0
        ? pending.body.map((line) => <p key={line}>{line}</p>)
        : null}
    </ConfirmDialog>
  );
}
