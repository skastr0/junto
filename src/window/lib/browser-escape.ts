/**
 * Whether Escape warm-detaches the browser surface in front. The browser's
 * own shell (WorkFocusShell) declines Escape, so the App's handler is what
 * detaches it; but Escape belongs to the topmost modal, and a modal above a
 * browser keeps it rather than handing it down. Detach only while the top
 * modal's container holds that browser surface, or while no modal is open.
 *
 * WorkbenchPanes renders every open surface, parked ones included (inert and
 * aria-hidden when not visible), so this query really answers "is the top
 * modal the workbench shell that owns the front browser", not "is that pane
 * visible". Today front comes from focusMru[0] and one shell holds them all;
 * a second shell, or telling a parked browser from the visible one, would
 * narrow this query.
 */
export const warmDetachOnEscape = (
  frontBrowserId: string | undefined,
  top: { readonly container: () => HTMLElement | null } | undefined,
): boolean => {
  if (frontBrowserId === undefined) return false;
  if (top === undefined) return true;
  const container = top.container();
  if (container === null) return false;
  return Array.from(container.querySelectorAll("[data-surface-id]")).some(
    (element) => element.getAttribute("data-surface-id") === frontBrowserId,
  );
};
