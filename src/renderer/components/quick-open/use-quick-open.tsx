import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { keyAria, keyCaps } from "../../lib/key-match";
import { registerQuickOpenHost } from "../../lib/quick-open-host";
import type { QuickOpenItem, QuickOpenSource } from "../../lib/quick-open";
import { isMac } from "../../lib/platform";
import { IconButton } from "../ui/IconButton";
import { QuickOpen } from "./QuickOpen";

export type QuickOpenControl = {
  /** The sidebar header's button, or null when this node has nothing to search. */
  readonly trigger: ReactNode;
  /** The palette, mounted only while it is open: render it beside the node's panes. */
  readonly palette: ReactNode;
};

/** A chord as its key caps in one word: "⌘P" on macOS, "Ctrl+P" elsewhere. */
const capsOf = (caps: readonly string[] | undefined): string | undefined =>
  caps === undefined ? undefined : caps.join(isMac() ? "" : "+");

/**
 * A node modal's quick open (0.11, F4): the header button, the palette, and
 * the registration that lets Cmd+P reach this node while its modal is up.
 *
 * The caller keeps its own list and says what opening a row does; the palette
 * only ranks through the source, so a new node (the Files one) needs this hook
 * and a `QuickOpenSource`, never a new palette.
 *
 * `source` must be stable (a `useMemo` over the rows): the palette re-asks on
 * a new source identity, and a fresh object per render would ask every frame.
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
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const showingRef = useRef(false);

  useEffect(() => {
    showingRef.current = showing;
  }, [showing]);

  const attach = useCallback((element: HTMLButtonElement | null) => {
    anchorRef.current = element;
    setAnchor(element);
  }, []);

  const close = useCallback(() => setShowing(false), []);

  // The chord's action finds this node's palette here, and only while the
  // modal shows: the last modal registered is the node in front.
  useEffect(
    () =>
      registerQuickOpenHost({
        nodeId,
        enabled,
        open: () => {
          if (anchorRef.current !== null) setShowing(true);
        },
        close,
        isOpen: () => showingRef.current,
      }),
    [nodeId, enabled, close],
  );

  const caps = capsOf(keyCaps("quickOpen.open"));
  const trigger = enabled ? (
    <IconButton
      ref={attach}
      aria-label={source.find}
      title={caps === undefined ? source.find : `${source.find} (${caps})`}
      aria-keyshortcuts={keyAria("quickOpen.open")}
      aria-expanded={showing}
      size="sm"
      onClick={() => setShowing((shown) => !shown)}
    >
      <Search size={14} aria-hidden />
    </IconButton>
  ) : null;

  const palette =
    showing && anchor !== null ? (
      <QuickOpen
        anchor={anchor}
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
