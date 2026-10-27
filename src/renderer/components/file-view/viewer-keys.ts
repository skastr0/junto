import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefCallback } from "react";
import { isOperatorTyping } from "../../lib/focus-ownership";
import type { BoxTools } from "./box-tools";

/**
 * The viewer's own keys while focus is inside it: + and - zoom, 0 shows the
 * actual size, B toggles the box tool, Escape drops a drawn box and then the
 * tool before the modal hears it. A key it uses goes no further.
 */
export const useViewerKeys = ({
  tools,
  zoomIn,
  zoomOut,
  actual,
}: {
  readonly tools: BoxTools;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly actual: () => void;
}) =>
  (event: KeyboardEvent): void => {
    if (event.nativeEvent.isComposing || isOperatorTyping(event.target)) return;
    let used = tools.onKey(event);
    if (!used && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "+" || event.key === "=") {
        zoomIn();
        used = true;
      } else if (event.key === "-") {
        zoomOut();
        used = true;
      } else if (event.key === "0") {
        actual();
        used = true;
      }
    }
    if (used) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

/** The pane's width in CSS pixels, kept current as it resizes: what Fit fits to. */
export const usePaneWidth = (): readonly [RefCallback<HTMLDivElement>, number, HTMLDivElement | null] => {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (element === null) return;
    setWidth(element.clientWidth);
    observer.current = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.current.observe(element);
    return () => observer.current?.disconnect();
  }, [element]);
  const ref = useCallback((next: HTMLDivElement | null) => setElement(next), []);
  return [ref, width, element] as const;
};
