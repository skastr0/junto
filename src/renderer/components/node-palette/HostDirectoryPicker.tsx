import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, ChevronRight, Folder, RefreshCw } from "lucide-react";
import type { HostDirectorySnapshot } from "@shared/host-directory";
import {
  bestDirectoryCompletion,
  directoryFromDraft,
  joinHostPath,
  matchDirectoryEntries,
  parseDirectoryDraft,
  trimTrailingSlash,
} from "../../lib/directory-picker";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { Button, IconButton, Input } from "../ui";

/** Typing a path settles before the listing follows it. */
const NAVIGATE_DEBOUNCE_MS = 180;

/** Inside a folder the input ends in a separator, so nothing reads as a filter. */
const asBrowsingDraft = (root: string): string =>
  root.endsWith("/") ? root : `${root}/`;

const isAbsoluteish = (path: string): boolean =>
  path.startsWith("/") || path.startsWith("~");

export function HostDirectoryPicker({
  hostId,
  initialPath,
  resetKey,
  onSelect,
  onDraftChange,
  inputAriaLabel = "Agent working directory",
}: {
  readonly hostId: string;
  readonly initialPath?: string;
  readonly resetKey?: string;
  /** Canonical directory this page can vouch for (empty when none). */
  readonly onSelect: (path: string) => void;
  /** Live typed draft — free text + browse. Region paths use this for save. */
  readonly onDraftChange?: (draft: string) => void;
  readonly inputAriaLabel?: string;
}) {
  const [draft, setDraft] = useState(initialPath?.trim() || "~");
  const [snapshot, setSnapshot] = useState<HostDirectorySnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activePath, setActivePath] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestRange = useRef<readonly [number, number] | undefined>(undefined);
  const loadSeq = useRef(0);
  const syncKeyRef = useRef("");

  const load = useCallback(async (path: string) => {
    const requestSeq = ++loadSeq.current;
    const target = path.trim() || "~";
    const api = getVellumCommandApi();
    if (!api?.hostDirectoryRead) {
      if (requestSeq === loadSeq.current) {
        setSnapshot(undefined);
        setError("Host filesystem browser is unavailable.");
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await api.hostDirectoryRead(hostId, target);
      if (requestSeq !== loadSeq.current) return undefined;
      setSnapshot(next);
      setActivePath(undefined);
      return next;
    } catch (reason) {
      if (requestSeq !== loadSeq.current) return undefined;
      setSnapshot(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      if (requestSeq === loadSeq.current) setLoading(false);
    }
  }, [hostId]);

  /** Move into a folder: the input follows the listing, not the other way. */
  const openDirectory = (path: string) => {
    setDraft(asBrowsingDraft(path));
    void load(path).then((next) => {
      if (next) setDraft(asBrowsingDraft(next.root));
    });
  };

  useEffect(() => {
    const seed = initialPath?.trim() || "~";
    const nextSyncKey = `${hostId}\0${resetKey ?? ""}`;
    if (syncKeyRef.current === nextSyncKey) return;
    syncKeyRef.current = nextSyncKey;
    setDraft(seed);
    setSnapshot(undefined);
    setActivePath(undefined);
    setError("");
    void load(seed).then((next) => {
      if (next) setDraft(asBrowsingDraft(next.root));
    });
  }, [hostId, initialPath, load, resetKey]);

  const { dir, query } = useMemo(() => parseDirectoryDraft(draft), [draft]);
  const selectedPath = directoryFromDraft(draft, snapshot);

  /**
   * A folder named outright is a selection, not a filter — the listing keeps
   * its shape and highlights the row instead of collapsing to one line.
   */
  const filter = selectedPath && selectedPath !== snapshot?.root ? "" : query;
  const rows = useMemo(
    () => matchDirectoryEntries(snapshot?.entries ?? [], filter),
    [snapshot, filter],
  );

  /** A typed path is followed once it settles; a typed word only filters. */
  useEffect(() => {
    if (!isAbsoluteish(dir)) return;
    const target = trimTrailingSlash(dir);
    if (snapshot && target === snapshot.root) return;
    const timer = setTimeout(() => void load(target), NAVIGATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dir, snapshot, load]);

  /** Report only the canonical directory this page can currently vouch for. */
  useEffect(() => {
    onSelect(selectedPath ?? "");
    // Reporting is keyed to the selection alone: an `onSelect` the parent
    // re-creates must not re-announce a selection that never changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  useEffect(() => {
    onDraftChange?.(draft);
    // Draft only — parent identity churn must not re-emit an unchanged draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useLayoutEffect(() => {
    const range = suggestRange.current;
    if (!range) return;
    suggestRange.current = undefined;
    inputRef.current?.setSelectionRange(range[0], range[1]);
  });

  /** Inline typeahead: complete the word, leave the completion selected. */
  const suggest = (typed: string, caret: number) => {
    if (!snapshot) return;
    const parsed = parseDirectoryDraft(typed);
    if (parsed.dir !== "" && trimTrailingSlash(parsed.dir) !== snapshot.root) {
      return;
    }
    if (caret !== typed.length) return;
    const match = bestDirectoryCompletion(snapshot.entries, parsed.query);
    if (!match) return;
    const completed = joinHostPath(parsed.dir || snapshot.root, match.name);
    suggestRange.current = [typed.length, completed.length];
    setDraft(completed);
  };

  const moveActive = (step: number) => {
    if (rows.length === 0) return;
    const current = rows.findIndex((entry) => entry.path === activePath);
    const next = current < 0
      ? (step > 0 ? 0 : rows.length - 1)
      : (current + step + rows.length) % rows.length;
    const entry = rows[next];
    if (!entry) return;
    setActivePath(entry.path);
    setDraft(entry.path);
  };

  const highlighted = activePath ?? selectedPath;

  return (
    <div className="grid min-h-0 gap-2 normal-case tracking-normal">
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const target = selectedPath ?? draft;
          openDirectory(trimTrailingSlash(target.trim()));
        }}
      >
        <Input
          ref={inputRef}
          aria-label={inputAriaLabel}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="~/Projects/project"
          onChange={(event) => {
            const typed = event.target.value;
            const caret = event.target.selectionStart ?? typed.length;
            const inserting =
              (event.nativeEvent as InputEvent).inputType?.startsWith("insert")
                ?? typed.length > draft.length;
            setActivePath(undefined);
            setDraft(typed);
            if (inserting) suggest(typed, caret);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
            }
          }}
        />
        <IconButton
          type="button"
          aria-label="Open parent directory"
          title="Parent directory"
          disabled={loading || snapshot?.parent === undefined}
          onClick={() => {
            if (snapshot?.parent) openDirectory(snapshot.parent);
          }}
        >
          <ArrowUp size={14} />
        </IconButton>
        <IconButton
          type="submit"
          aria-label="Open directory"
          title="Open directory"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
        </IconButton>
      </form>

      <div className="min-h-[160px] overflow-hidden rounded-[5px] border border-stroke bg-inset">
        {loading && !snapshot ? (
          <div role="status" className="px-3 py-6 text-center text-[11px] text-dim">
            Reading {hostId}…
          </div>
        ) : null}
        {!loading && error ? (
          <div role="alert" className="px-3 py-6 text-center text-[11px] text-crimson">
            {error}
          </div>
        ) : null}
        {snapshot && !error ? (
          <ul
            aria-label={`Folders in ${snapshot.root}`}
            className="grid max-h-[220px] gap-px overflow-y-auto p-1 font-mono text-[11px]"
          >
            {rows.map((entry) => (
              <li key={entry.path}>
                <div
                  className={[
                    "group flex items-center gap-1 rounded-[4px] pr-1",
                    entry.path === highlighted
                      ? "bg-raise text-ink"
                      : "text-ink-2 hover:bg-raise/60",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    aria-label={`Select ${entry.name}`}
                    aria-current={entry.path === selectedPath}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                    onClick={() => {
                      setActivePath(entry.path);
                      setDraft(entry.path);
                    }}
                    onDoubleClick={() => openDirectory(entry.path)}
                  >
                    <Folder size={11} className="shrink-0 opacity-60" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                  <IconButton
                    type="button"
                    aria-label={`Open ${entry.name}`}
                    title="Open folder"
                    onClick={() => openDirectory(entry.path)}
                  >
                    <ChevronRight size={12} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {snapshot && !loading && !error && rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-dim">
            {filter ? `No folder matches “${filter}”` : "No subfolders"}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] text-dim">
        <span className="min-w-0 truncate font-mono">
          {selectedPath ?? snapshot?.root ?? draft}
        </span>
        <Button
          type="button"
          size="xs"
          variant="subtle"
          disabled={!snapshot || loading}
          onClick={() => {
            if (!snapshot) return;
            setActivePath(undefined);
            setDraft(asBrowsingDraft(snapshot.root));
          }}
        >
          use this folder
        </Button>
      </div>
    </div>
  );
}
