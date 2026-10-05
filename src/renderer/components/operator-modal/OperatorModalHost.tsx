import { use$ } from "@legendapp/state/react";
import { useEffect, type ComponentType } from "react";
import { isOperatorTyping } from "../../lib/focus-ownership";
import { cancelFocusSwitcher } from "../../lib/focus-switcher";
import {
  openOperatorModal,
  operatorModal$,
  operatorModalForKey,
  TERMINAL_SELECTOR,
  toggleOperatorModal,
  type OperatorModalId,
} from "../../lib/operator-modal";
import { isMac } from "../../lib/platform";
import { CommandBar } from "../command-bar/CommandBar";

// The operator modals. A modal joins the layer by adding its body here; its
// chord is in operatorModalForKey. Until the feed body lands here its chord
// is still its own host's.
const MODALS: Partial<Record<OperatorModalId, ComponentType>> = {
  search: CommandBar,
};

/**
 * The one host for operator modals. Always mounted, above every working
 * modal: it owns the chords and renders whichever modal the slot holds.
 * Opening is one observable write; nothing here waits on the canvas or on a
 * working modal.
 */
export function OperatorModalHost() {
  const open = use$(operatorModal$.open);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      const id = operatorModalForKey(event, {
        mac: isMac(),
        typing: isOperatorTyping(target),
        terminal: target?.closest(TERMINAL_SELECTOR) != null,
      });
      if (!id || !MODALS[id]) return;
      event.preventDefault();
      event.stopPropagation();
      // The switcher is an operator surface too: one at a time.
      cancelFocusSwitcher();
      if (event.key === "/") openOperatorModal(id);
      else toggleOperatorModal(id);
    };
    // Capture phase: the chord opens from inside a terminal or a working
    // modal before either can act on it.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
  const Body = open ? MODALS[open] : undefined;
  return Body ? <Body /> : null;
}
