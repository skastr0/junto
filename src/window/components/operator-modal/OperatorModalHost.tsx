import { use$ } from "@legendapp/state/react";
import { useEffect, type ComponentType } from "react";
import { operatorModal$, type OperatorModalId } from "../../lib/operator-modal";
import { openQuickThread } from "../../lib/quick-thread";
import { provideThreadKey } from "../../lib/thread-keys";
import { CommandBar } from "../command-bar/CommandBar";
import { OperatorFeed } from "../feed/OperatorFeed";
import { OperatorThreads } from "../feed/OperatorThreads";
import { CommitReviewModal } from "../git/CommitReviewModal";
import { QuickCapture } from "../capture/QuickCapture";
import { QuickThreadModal } from "../quick-thread/QuickThreadModal";

// The operator modals. A modal joins the layer by adding its body here; its
// chord is a row in the key table.
const MODALS: Record<OperatorModalId, ComponentType> = {
  search: CommandBar,
  feed: OperatorFeed,
  // Opened from a commit on a needs-you card; closing it returns to that card.
  git: CommitReviewModal,
  // Cmd+T: a new document with the caret in it, and the canvas's artifacts beside it.
  capture: QuickCapture,
  // Cmd+U: the operator's threads across every seat, the feed's sibling.
  threads: OperatorThreads,
  // Cmd+Shift+U: a new thread to a seat, or the same one to several, from anywhere.
  "quick-thread": QuickThreadModal,
};

/**
 * The one host for operator modals. Always mounted, above every working
 * modal: it renders whichever modal the slot holds. Opening is one
 * observable write; nothing here waits on the canvas or on a working modal.
 */
export function OperatorModalHost() {
  const open = use$(operatorModal$.open);
  // The Quick thread key lands here from anywhere; a surface in front that
  // starts threads itself answers it instead while it is open (lib/thread-keys).
  useEffect(() => provideThreadKey("threads.quick", openQuickThread), []);
  const Body = open ? MODALS[open] : undefined;
  return Body ? <Body /> : null;
}
