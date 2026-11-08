import { use$ } from "@legendapp/state/react";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { answerDraftsAsk, draftsAsk$ } from "../../lib/files-drafts-settle";
import { Button, Dialog } from "../ui";

/**
 * The ask before the window goes with unsaved files: Save all, Discard, or
 * Cancel. Mounted once; `settleFileDrafts` opens it. Focus starts on Cancel,
 * so Enter never drops a draft by accident.
 */
export function UnsavedFilesHost() {
  const pending = use$(draftsAsk$.pending);
  if (!pending) return null;
  const { names, refused, busy } = pending;
  const title = names.length === 1 ? `Save changes to ${names[0]!}?` : `Save changes to ${String(names.length)} files?`;
  return (
    <Dialog
      alert
      title={title}
      testId="unsaved-files-dialog"
      onClose={() => {
        if (!busy) answerDraftsAsk("cancel");
      }}
      actions={
        <>
          <Button ref={claimFocusOnMount} size="md" variant="chrome" disabled={busy} onClick={() => answerDraftsAsk("cancel")}>
            Cancel
          </Button>
          <Button size="md" variant="danger" disabled={busy} onClick={() => answerDraftsAsk("discard")}>
            Discard
          </Button>
          <Button size="md" variant="primary" disabled={busy} onClick={() => answerDraftsAsk("save")}>
            {busy ? "Saving" : "Save all"}
          </Button>
        </>
      }
    >
      {refused.length > 0 ? (
        <>
          <p>These could not be saved, so nothing closed:</p>
          <ul>
            {refused.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{names.length === 1 ? "Its changes are lost if you don't save them." : `${names.join(", ")} have changes that are lost if you don't save them.`}</p>
      )}
    </Dialog>
  );
}
