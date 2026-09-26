/**
 * The customize-agent editor, opened from anywhere: the focus header portrait,
 * the seat toolbar, the seat right-click menu, the selection bar. One editor
 * is open at a time; opening another seat moves it.
 *
 * The anchor element lives outside the observable (a DOM node is not state);
 * with none, or once it leaves the document, the editor sits beside the seat
 * on the canvas.
 */
import { observable } from "@legendapp/state";

export const agentEditor$ = observable<{
  readonly seatId: string;
  readonly section?: string;
  /** Bumps on every open, so reopening the same seat re-anchors. */
  readonly opened: number;
} | null>(null);

let anchorElement: HTMLElement | null = null;
let opens = 0;

export const openAgentEditor = (
  seatId: string,
  options: { readonly anchor?: HTMLElement | null; readonly section?: string } = {},
): void => {
  anchorElement = options.anchor ?? null;
  opens += 1;
  agentEditor$.set({ seatId, ...(options.section ? { section: options.section } : {}), opened: opens });
};

export const closeAgentEditor = (): void => {
  anchorElement = null;
  agentEditor$.set(null);
};

/** Open for this seat, or close it when it is already open for it. */
export const toggleAgentEditor = (
  seatId: string,
  options: { readonly anchor?: HTMLElement | null; readonly section?: string } = {},
): void => {
  if (agentEditor$.peek()?.seatId === seatId) closeAgentEditor();
  else openAgentEditor(seatId, options);
};

/** Where the editor should sit: the opener if still on screen, else the seat. */
export const agentEditorAnchor = (seatId: string): HTMLElement | null => {
  if (anchorElement?.isConnected) return anchorElement;
  return [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((node) => node.dataset.id === seatId) ?? null;
};
