/**
 * Whether Escape warm-detaches the browser surface in front. The browser's
 * own shell (WorkFocusShell) declines Escape, so the App's handler is what
 * detaches it; but Escape belongs to the topmost modal, and a modal above a
 * browser keeps it rather than handing it down. Detach only while the top
 * modal's container holds that browser surface, or while no modal is open.
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
