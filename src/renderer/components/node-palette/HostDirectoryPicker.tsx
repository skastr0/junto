import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronRight, Folder, RefreshCw } from "lucide-react";
import type { HostDirectoryEntry, HostDirectorySnapshot } from "@shared/host-directory";
import {
  directoryCompletion,
  directoryFromDraft,
  expandDraft,
  matchDirectoryEntries,
  parseDirectoryDraft,
  trimTrailingSlash,
  type DirectoryPage,
} from "../../lib/directory-picker";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, Combobox, IconButton } from "../ui";

/** Typing a path settles before the listing follows it. */
const NAVIGATE_DEBOUNCE_MS = 180;

/** Inside a folder the input ends in a separator, so nothing reads as a filter. */
const asBrowsingDraft = (root: string): string =>
  root.endsWith("/") ? root : `${root}/`;

const isAbsoluteish = (path: string): boolean =>
  path.startsWith("/") || path.startsWith("~");

const STATUS_CLASS = "px-3 py-6 text-center text-[11px]";

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
  const [page, setPage] = useState<DirectoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activePath, setActivePath] = useState<string>();
  /**
   * The user has written the draft since the picker last moved on its own.
   * From then on a load may change the listing but never the draft.
   */
  const userOwnsDraft = useRef(false);
  const loadSeq = useRef(0);
  const syncKeyRef = useRef("");
  const attemptedTarget = useRef<string>("");

  const load = useCallback(async (path: string) => {
    const requestSeq = ++loadSeq.current;
    const target = path.trim() || "~";
    attemptedTarget.current = target;
    const api = getJuntoApi();
    if (!api?.hostDirectoryRead) {
      if (requestSeq === loadSeq.current) {
        setPage(undefined);
        setError("Host filesystem browser is unavailable.");
        setLoading(false);
      }
      return undefined;
    }
    setLoading(true);
    setError("");
    try {
      const next = await api.hostDirectoryRead(hostId, target);
      if (requestSeq !== loadSeq.current) return undefined;
      setPage({ requested: target, snapshot: next });
      setActivePath(undefined);
      return next;
    } catch (reason) {
      if (requestSeq !== loadSeq.current) return undefined;
      setPage(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      if (requestSeq === loadSeq.current) setLoading(false);
    }
  }, [hostId]);

  /**
   * Show a folder the picker moved to on its own (seed, open, parent). Once
   * the listing answers, the draft reads as the folder's real path, unless
   * the user has written in the meantime.
   */
  const showDirectory = (shown: string, path: string) => {
    userOwnsDraft.current = false;
    setDraft(shown);
    setActivePath(undefined);
    void load(path).then((next: HostDirectorySnapshot | undefined) => {
      if (!next || userOwnsDraft.current) return;
      setDraft(asBrowsingDraft(next.root));
    });
  };

  const openDirectory = (path: string) => showDirectory(asBrowsingDraft(path), path);

  const writeDraft = (next: string) => {
    userOwnsDraft.current = true;
    setDraft(next);
  };

  useEffect(() => {
    const seed = initialPath?.trim() || "~";
    const nextSyncKey = `${hostId}\0${resetKey ?? ""}`;
    if (syncKeyRef.current === nextSyncKey) return;
    syncKeyRef.current = nextSyncKey;
    setPage(undefined);
    setError("");
    showDirectory(seed, seed);
    // The seed is keyed to host + resetKey alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, initialPath, load, resetKey]);

  /** The draft as this page reads it: "~/Pro" on the home page is absolute. */
  const expanded = expandDraft(draft, page);
  const { dir, query } = useMemo(() => parseDirectoryDraft(expanded), [expanded]);
  const typedDir = parseDirectoryDraft(draft).dir;
  const snapshot = page?.snapshot;
  const selectedPath = directoryFromDraft(expanded, snapshot);

  /**
   * A folder named outright is a selection, not a filter — the listing keeps
   * its shape and marks the row instead of collapsing to one line.
   */
  const filter = selectedPath && selectedPath !== snapshot?.root ? "" : query;
  const rows = useMemo(
    () => matchDirectoryEntries(snapshot?.entries ?? [], filter),
    [snapshot, filter],
  );
  const activeEntry = rows.find((entry) => entry.path === activePath);
  const completion = directoryCompletion(draft, page, activeEntry);

  /**
   * The listing follows a folder the typed text names up to a separator (a
   * typed or accepted trailing "/"); a word being typed only filters.
   */
  useEffect(() => {
    if (!isAbsoluteish(typedDir)) return;
    if (snapshot && trimTrailingSlash(dir) === snapshot.root) return;
    const target = trimTrailingSlash(typedDir);
    // Same target already attempted (seed load, success, or error). Do not
    // re-issue every 180ms — that is the remote-picker blink.
    if (attemptedTarget.current === target) return;
    const timer = setTimeout(() => void load(target), NAVIGATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typedDir, dir, snapshot, load]);

  /** Report only the canonical directory this page can currently vouch for. */
  useEffect(() => {
    onSelect(selectedPath ?? "");
    // Reporting is keyed to the selection alone: an `onSelect` the parent
    // re-creates must not re-announce a selection that never changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  useEffect(() => {
    onDraftChange?.(expanded);
    // Draft only — parent identity churn must not re-emit an unchanged draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const openTyped = (value: string) =>
    openDirectory(trimTrailingSlash(value.trim()) || "~");

  let status: ReactNode;
  if (!loading && error) {
    status = <div role="alert" className={`${STATUS_CLASS} text-crimson`}>{error}</div>;
  } else if (!snapshot) {
    status = <div role="status" className={`${STATUS_CLASS} text-dim`}>Reading {hostId}…</div>;
  }
  const empty = loading ? null : (
    <div className={`${STATUS_CLASS} text-dim`}>
      {filter ? `No folder matches “${filter}”` : "No subfolders"}
    </div>
  );

  return (
    <div className="grid min-h-0 gap-2 normal-case tracking-normal">
      <Combobox<HostDirectoryEntry>
        aria-label={inputAriaLabel}
        listLabel={`Folders in ${snapshot?.root ?? draft}`}
        placeholder="~/Projects/project"
        value={draft}
        onValueChange={writeDraft}
        completion={completion}
        options={rows}
        optionKey={(entry) => entry.path}
        activeKey={activeEntry?.path}
        onActiveKeyChange={setActivePath}
        selectedKey={selectedPath}
        onCommit={(entry, value) =>
          entry ? openDirectory(entry.path) : openTyped(value)
        }
        onOptionClick={(entry) => {
          writeDraft(entry.path);
          setActivePath(entry.path);
        }}
        onOptionDoubleClick={(entry) => openDirectory(entry.path)}
        status={status}
        empty={empty}
        listClassName="min-h-[160px]"
        trailing={
          <>
            <IconButton
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
              aria-label="Open directory"
              title="Open directory"
              disabled={loading}
              onClick={() => openTyped(selectedPath ?? draft)}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            </IconButton>
          </>
        }
        renderOption={(entry) => (
          <div className="flex items-center gap-1 pr-1">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1">
              <Folder size={11} className="shrink-0 opacity-60" />
              <span className="truncate">{entry.name}</span>
            </span>
            {/*
              Pointer shortcut for "open". Not a button: an option may not hold
              interactive children, and Enter / Tab already open from the keys.
            */}
            <span
              aria-hidden
              title="Open folder"
              className="grid size-6 shrink-0 place-items-center rounded text-steel transition-colors hover:bg-white/10 hover:text-ink"
              onClick={(event) => {
                event.stopPropagation();
                openDirectory(entry.path);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <ChevronRight size={12} />
            </span>
          </div>
        )}
      />

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
            writeDraft(asBrowsingDraft(snapshot.root));
          }}
        >
          use this folder
        </Button>
      </div>
    </div>
  );
}
