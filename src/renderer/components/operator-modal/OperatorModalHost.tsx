import { use$ } from "@legendapp/state/react";
import type { ComponentType } from "react";
import { operatorModal$, type OperatorModalId } from "../../lib/operator-modal";
import { CommandBar } from "../command-bar/CommandBar";
import { OperatorFeed } from "../feed/OperatorFeed";

// The operator modals. A modal joins the layer by adding its body here; its
// chord is a row in the key table.
const MODALS: Record<OperatorModalId, ComponentType> = {
  search: CommandBar,
  feed: OperatorFeed,
};

/**
 * The one host for operator modals. Always mounted, above every working
 * modal: it renders whichever modal the slot holds. Opening is one
 * observable write; nothing here waits on the canvas or on a working modal.
 */
export function OperatorModalHost() {
  const open = use$(operatorModal$.open);
  const Body = open ? MODALS[open] : undefined;
  return Body ? <Body /> : null;
}
