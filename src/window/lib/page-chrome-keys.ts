/**
 * The page chrome's keys: Cmd+L and Cmd+R act on the page in front. The
 * chrome of a page surface registers what each does while it shows; the
 * last one registered is the page in front. With none registered the key
 * passes, so a chord meant for a page never acts on anything else.
 */

export type PageChromeKeys = {
  /** Put the keyboard in the address bar, its address selected. */
  readonly address: () => void;
  /** Load the page again. */
  readonly reload: () => void;
};

const registered: PageChromeKeys[] = [];

/** Register a showing page's chrome; call the returned function when it hides. */
export const registerPageChromeKeys = (keys: PageChromeKeys): (() => void) => {
  registered.push(keys);
  return () => {
    const at = registered.lastIndexOf(keys);
    if (at >= 0) registered.splice(at, 1);
  };
};

/** Run one of the front page's keys; false when no page shows, so the key passes. */
export const runPageChromeKey = (key: keyof PageChromeKeys): boolean => {
  const front = registered.at(-1);
  if (front === undefined) return false;
  front[key]();
  return true;
};
