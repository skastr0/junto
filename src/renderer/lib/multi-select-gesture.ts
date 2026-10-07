/**
 * Shift multi-select is product law: when Shift is held, a primary press on a
 * node is additive selection — never open, rename, edit, or other chrome.
 *
 * React Flow multiSelectionKeyCode is Shift, but nodrag chrome (actor labels,
 * toolbar, note surfaces) stopPropagation and steal the click. Capture-phase
 * handlers force RF selection and kill chrome for the gesture.
 */
import { useCallback } from "react";
import { useStoreApi } from "@xyflow/react";
import { isOperatorTyping } from "./focus-ownership";
import { clearSelection } from "./state";

/** Junto multi-select modifier (matches ReactFlow multiSelectionKeyCode). */
export function isMultiSelectGesture(
  event: Pick<MouseEvent | PointerEvent | KeyboardEvent, "shiftKey">,
): boolean {
  return event.shiftKey === true;
}

/** True when the event target is a focused text field we must not hijack. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  return isOperatorTyping(target);
}

/**
 * Node chrome: stopPropagation only when this is NOT multi-select.
 * Returns true when the caller must yield (shift multi-select owns the event).
 */
export function stopNodeGestureUnlessMultiSelect(
  event: {
    readonly shiftKey: boolean;
    stopPropagation: () => void;
    preventDefault?: () => void;
  },
  options?: { readonly preventDefault?: boolean },
): boolean {
  if (isMultiSelectGesture(event)) return true;
  event.stopPropagation();
  if (options?.preventDefault) event.preventDefault?.();
  return false;
}

/**
 * A shift-press on a card: put it in the selection, or take it out. Taking the
 * last one out leaves nothing selected. React Flow says so with an empty
 * selection, which the canvas ignores because it also sends one whenever the
 * graph remounts; here it is the operator's own act, so the window's selection
 * is cleared with it.
 */
export function toggleInSelection(store: ReturnType<typeof useStoreApi>, nodeId: string): void {
  const state = store.getState();
  const node = state.nodeLookup.get(nodeId);
  if (!node) return;
  // React Flow adds to a selection only while it believes the multi-select
  // key is down, and it may not have seen the key yet. So it is told so for
  // this one act, and told the truth again straight after: left on, React
  // Flow goes on treating every later click on a selected card as taking it
  // out, and a release at the end of a drag is such a click, so the card the
  // operator dragged a group by would drop out of the group.
  const wasMulti = state.multiSelectionActive;
  if (!wasMulti) store.setState({ multiSelectionActive: true });
  try {
    if (!node.selected) {
      state.addSelectedNodes([nodeId]);
      return;
    }
    state.unselectNodesAndEdges({ nodes: [node], edges: [] });
    const others =
      [...state.nodeLookup.values()].some((other) => other.id !== nodeId && other.selected) ||
      state.edges.some((edge) => edge.selected);
    if (!others) clearSelection();
  } finally {
    if (!wasMulti) store.setState({ multiSelectionActive: false });
  }
}

/**
 * Capture-phase handlers for a node shell: Shift+primary press toggles this
 * node in the multi-selection and prevents all child chrome from running.
 */
export function useShiftMultiSelectDominance(nodeId: string): {
  readonly onPointerDownCapture: (event: React.PointerEvent) => void;
  readonly onClickCapture: (event: React.MouseEvent) => void;
} {
  const store = useStoreApi();

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent) => {
      if (!isMultiSelectGesture(event) || event.button !== 0) return;
      if (isEditableEventTarget(event.target)) return;

      // Own the gesture completely — children never see open/rename/edit.
      event.preventDefault();
      event.stopPropagation();

      toggleInSelection(store, nodeId);
    },
    [store, nodeId],
  );

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!isMultiSelectGesture(event)) return;
    if (isEditableEventTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onPointerDownCapture, onClickCapture };
}
