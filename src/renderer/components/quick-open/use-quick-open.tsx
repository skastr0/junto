import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileSearch, Search } from "lucide-react";
import { claimFocus } from "../../lib/focus-ownership";
import { keyAria, keyCaps } from "../../lib/key-match";
import { registerQuickOpenHost } from "../../lib/quick-open-host";
import type { QuickOpenItem, QuickOpenSource } from "../../lib/quick-open";
import { isMac } from "../../lib/platform";
import { IconButton } from "../ui/IconButton";
import { QuickOpen } from "./QuickOpen";

export type QuickOpenControl = {
  /** The sidebar header's button, or null when this node has nothing to search. */
  readonly trigger: ReactNode;
  /** The palette, mounted only while it is open: render it inside the modal's shell. */
  readonly palette: ReactNode;
};

/** A chord as its key caps in one word: "⌘P" on macOS, "Ctrl+P" elsewhere. */
const capsOf = (caps: readonly string[] | undefined): string | undefined =>
  caps === undefined ? undefined : caps.join(isMac() ? "" : "+");

/**
 * A node modal's quick open (0.11, F4): the header button, the palette, and
 * the registration that lets Cmd+P reach this modal while it shows.
 *
 * The caller keeps its own list and says what opening a row does; the palette
 * only ranks through the source, so a new node (the Files one) needs this hook
 * and a `QuickOpenSource`, never a new palette. Render `palette` inside the
 * modal's shell, where the palette fills the modal's own panel.
 */
export const useQuickOpen = ({
  nodeId,
  source,
  enabled,
  onOpen,
}: {
  readonly nodeId: string;
  readonly source: QuickOpenSource;
  /** False for a node holding nothing to search: no button, and the key passes. */
  readonly enabled: boolean;
  readonly onOpen: (item: QuickOpenItem) => void;
}): QuickOpenControl => {
  const [showing, setShowing] = useState(false);
  const showingRef = useRef(false);
  /** What had the keyboard when the palette opened: it goes back there on close. */
  const before = useRef<HTMLElement | null>(null);

  useEffect(() => {
    showingRef.current = showing;
  }, [showing]);

  const open = useCallback(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    before.current = active instanceof HTMLElement ? active : null;
    setShowing(true);
  }, []);

  const close = useCallback(() => setShowing(false), []);

  // The palette unmounts and the keyboard would fall to the page: hand it back
  // to whatever had it, unless the operator has already put it somewhere else.
  useEffect(() => {
    if (showing) return;
    const back = before.current;
    before.current = null;
    if (back === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    claimFocus(back, "gesture");
  }, [showing]);

  // The chord's action finds this modal's palette here, and only while the
  // modal shows: the last modal registered is the one in front.
  useEffect(
    () =>
      registerQuickOpenHost({
        nodeId,
        enabled,
        open,
        close,
        isOpen: () => showingRef.current,
      }),
    [nodeId, enabled, open, close],
  );

  const Glyph = source.kind === "file" ? FileSearch : Search;
  const caps = capsOf(keyCaps("quickOpen.open"));
  const trigger = enabled ? (
    <IconButton
      aria-label={source.find}
      title={caps === undefined ? source.find : `${source.find} (${caps})`}
      aria-keyshortcuts={keyAria("quickOpen.open")}
      aria-expanded={showing}
      size="sm"
      onClick={() => (showing ? close() : open())}
    >
      <Glyph size={14} aria-hidden />
    </IconButton>
  ) : null;

  const palette =
    showing ? (
      <QuickOpen
        source={source}
        onOpen={(item) => {
          setShowing(false);
          onOpen(item);
        }}
        onClose={close}
      />
    ) : null;

  return { trigger, palette };
};
