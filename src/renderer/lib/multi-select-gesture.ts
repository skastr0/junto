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

      const state = store.getState();
      // Key-tracking lag: force multi mode from the event itself.
      if (!state.multiSelectionActive) {
        store.setState({ multiSelectionActive: true });
      }
      const node = state.nodeLookup.get(nodeId);
      if (!node) return;
      if (!node.selected) {
        state.addSelectedNodes([nodeId]);
      } else {
        state.unselectNodesAndEdges({ nodes: [node], edges: [] });
      }
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
