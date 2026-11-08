/**
 * Motion no one can see stops (operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8).
 * One observer marks a watched element `data-unseen` while no part of it
 * lies in the window, clipped away by an ancestor or scrolled out included;
 * CSS stops its loops there. Set on the DOM, never a render. An element is
 * seen until the observer says otherwise, so no visible motion waits on it.
 */
let observer: IntersectionObserver | undefined;

const unseenObserver = (): IntersectionObserver | undefined => {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return undefined;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute("data-unseen", !entry.isIntersecting);
  });
  return observer;
};

export const watchUnseen = (el: Element): (() => void) => {
  const io = unseenObserver();
  io?.observe(el);
  return () => {
    io?.unobserve(el);
    el.removeAttribute("data-unseen");
  };
};

/** A ref callback that watches its element for as long as it is mounted. */
export const unseenRef = (el: Element | null): (() => void) | undefined => (el ? watchUnseen(el) : undefined);
