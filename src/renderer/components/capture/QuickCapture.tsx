import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Search, X } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/resource-command";
import { claimFocus, isOperatorTyping } from "../../lib/focus-ownership";
import { keyIs, keyCaps } from "../../lib/key-match";
import { isMac } from "../../lib/platform";
import { useCanvasArtifacts } from "../../lib/capture-artifacts";
import { nodeViewStore } from "../../lib/node-view-state";
import { registerCanvasDraftCommit } from "../../lib/canvas-editor-flush";
import { useCaptureInbox } from "../../lib/capture-inbox";
import { state$ } from "../../lib/state";
import { closeOperatorModal } from "../../lib/operator-modal";
import { focusCanvasNode } from "../../lib/command-bar";
import {
  comboboxFieldAria,
  listboxAria,
  optionAria,
  optionId,
  type ListboxAriaState,
} from "../../lib/listbox-aria";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { Kbd, ResourceGlyphMark } from "../ui";
import { CaptureEditor, type CaptureArtifactRef, type CaptureFlush, type CaptureView } from "./CaptureEditor";
import { CaptureMoveColumn, ROUTE_KEYS as CAPTURE_ROUTES, useCaptureMove } from "./CaptureMoveColumn";
import { CapturePreview } from "./CapturePreview";
import { CaptureInboxAsk } from "./CaptureInboxAsk";
import { captureRowsOf, type CaptureRow } from "./capture-list";
import { EMPTY_CAPTURE_DESK, type CaptureDeskState } from "./capture-desk-state";
import "./quick-capture.css";

/**
 * Quick capture (0.11, 11 Q1): Cmd+T opens on a new document with the caret
 * in it, and the same surface searches every artifact on the canvas beside
 * it. A new capture is the right half until the operator arrows into the
 * list; the focused row then previews there, and Enter edits it in place.
 *
 * The capture itself belongs to product-documents (Q2): the editor that
 * writes into the Inbox, the title from the first line, the type switch and
 * the routing. Their CaptureEditor replaces the stand-in below, on the same
 * `open`/`onArtifact` seam.
 */

type Edit =
  | { readonly kind: "new"; readonly key: number }
  | { readonly kind: "artifact"; readonly row: CaptureRow }
  /** The writing the desk left open, before its row is in the list. */
  | { readonly kind: "reopened"; readonly nodeId: string; readonly artifactId: string }
  | { readonly kind: "preview"; readonly row: CaptureRow | undefined };

/** How often the writing's place is kept while the operator works in it. */
const PLACE_EVERY_MS = 400;

/** A chord as its key caps in one word: "⌘N" on macOS, "Ctrl+N" elsewhere. */
const capsOf = (caps: readonly string[] | undefined): string | undefined =>
  caps === undefined ? undefined : caps.join(isMac() ? "" : "+");

const rowLabel = (row: CaptureRow): string => (row.title === "" ? "Untitled" : row.title);

export function QuickCapture() {
  const canvasName = use$(state$.canvasName);
  const heads = useCanvasArtifacts(canvasName);
  const inbox = useCaptureInbox(canvasName);
  // The desk the operator left: what was open, the query, the focused row and
  // the place in the writing, read once as the surface opens.
  const [desk] = useState<CaptureDeskState>(() => {
    const stored = canvasName === "" ? undefined : nodeViewStore().captureDesk(canvasName);
    return stored ?? EMPTY_CAPTURE_DESK;
  });
  const [query, setQuery] = useState(desk.query);
  const [active, setActive] = useState<string | undefined>(desk.focused ?? undefined);
  const [edit, setEdit] = useState<Edit>(() =>
    desk.open.kind === "artifact"
      ? { kind: "reopened", nodeId: desk.open.nodeId, artifactId: desk.open.artifactId }
      : { kind: "new", key: 0 },
  );
  /** What the desk row says now; a write carries the whole of it. */
  const deskNow = useRef<CaptureDeskState>(desk);
  const deskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The writing's flush and place, set by whichever editor is mounted. */
  const flushRef = useRef<CaptureFlush | null>(null);
  const viewRef = useRef<CaptureView | null>(null);
  /**
   * Keep the desk: the pointer to the writing, the query, the focused row, and
   * where in the writing the operator was. Coalesced, so a keystroke costs no
   * write of its own, and never awaited: a desk that cannot be kept must not
   * stop the writing.
   */
  const keepDesk = useCallback(
    (patch: Partial<CaptureDeskState>, now = false): void => {
      deskNow.current = { ...deskNow.current, ...patch };
      if (canvasName === "") return;
      if (deskTimer.current !== null) {
        if (!now) return;
        clearTimeout(deskTimer.current);
      }
      const write = (): void => {
        deskTimer.current = null;
        void nodeViewStore().writeCaptureDesk(canvasName, deskNow.current);
      };
      if (now) write();
      else deskTimer.current = setTimeout(write, PLACE_EVERY_MS);
    },
    [canvasName],
  );
  /** Where the operator is in the writing now, as the editor reads it. */
  const keepPlace = useCallback((): void => {
    const view = viewRef.current?.read();
    if (view === null || view === undefined) return;
    keepDesk({ caret: view.caret, scrollWriting: view.scroll });
  }, [keepDesk]);
  const searchRef = useRef<HTMLInputElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const rows = useMemo(
    () => captureRowsOf(heads, inbox as NodeId | undefined, query),
    [heads, inbox, query],
  );
  const activeRow = rows.find((row) => row.artifactId === active) ?? rows[0];
  /** The new capture once it is made, by the key of the capture it is: Cmd+N's next one starts unmade. */
  const [made, setMade] = useState<{ readonly key: number; readonly ref: CaptureArtifactRef } | undefined>(undefined);
  // Inbox first, then everything else, each under its own small heading; a
  // search is one flat list with no heading (Cmd+K's list).
  const groups = useMemo(() => {
    if (query.trim() !== "") return [{ key: "matches", label: null, rows }];
    const inInbox: CaptureRow[] = [];
    const recent: CaptureRow[] = [];
    for (const row of rows) (inbox !== undefined && row.nodeId === inbox ? inInbox : recent).push(row);
    return [
      { key: "inbox", label: "Inbox", rows: inInbox },
      { key: "recent", label: "Recent", rows: recent },
    ].filter((group) => group.rows.length > 0);
  }, [rows, inbox, query]);
  // The row as it is now, not the snapshot taken when it was picked: a body
  // that changed under an open preview still reads its newest text.
  const previewRow =
    edit.kind === "preview" && edit.row !== undefined
      ? rows.find((row) => row.artifactId === edit.row!.artifactId) ?? edit.row
      : undefined;
  // The open Move to column owns the routes; the surface only sends keys to it.
  const aria: ListboxAriaState = {
    baseId,
    presentation: "inline",
    autocomplete: "list",
    open: true,
    keys: rows.map((row) => row.artifactId),
    activeKey: activeRow?.artifactId,
    selection: { kind: "highlight" },
  };

  // The caret is in the document when the surface opens, and in whatever the
  // right half comes to hold: the editor's engine loads lazily, so the claim
  // waits for its line to exist rather than landing on the frame.
  // What Move to moves: the open capture, or the focused row; nothing while a new capture is unmade.
  const newKey = edit.kind === "new" ? edit.key : 0;
  const moveTarget: CaptureArtifactRef | undefined =
    edit.kind === "artifact"
      ? { nodeId: edit.row.nodeId as NodeId, artifactId: edit.row.artifactId as ItemId }
      : edit.kind === "preview" && previewRow !== undefined
        ? { nodeId: previewRow.nodeId as NodeId, artifactId: previewRow.artifactId as ItemId }
        : made?.key === newKey
          ? made.ref
          : undefined;
  const move = useCaptureMove(canvasName, moveTarget);

  const openKey =
    edit.kind === "new"
      ? `new-${String(edit.key)}`
      : edit.kind === "artifact"
        ? edit.row.artifactId
        : edit.kind === "reopened"
          ? edit.artifactId
          : "preview";
  useEffect(() => {
    let live = true;
    const claim = (): boolean => {
      const entry = rightRef.current?.querySelector<HTMLElement>("[data-capture-entry] .cm-content");
      if (!live || entry == null) return false;
      claimFocus(entry, "open");
      return true;
    };
    if (claim()) return () => { live = false; };
    const right = rightRef.current;
    if (right === null) return () => { live = false; };
    const observer = new MutationObserver(() => {
      if (claim()) observer.disconnect();
    });
    observer.observe(right, { childList: true, subtree: true });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [openKey]);

  // A desk that names an artifact this canvas no longer offers (deleted,
  // archived, or another canvas) opens a new capture rather than a writing
  // that never arrives. The list loads after the surface does, so the check
  // waits for it.
  useEffect(() => {
    if (edit.kind !== "reopened" || heads.length === 0) return;
    if (heads.some((head) => head.artifact.artifactId === edit.artifactId)) return;
    setEdit({ kind: "new", key: 0 });
    keepDesk({ open: { kind: "new" }, focused: null }, true);
  }, [edit, heads, keepDesk]);

  // The place the desk saved comes back once the writing's engine has lines:
  // asked before that, the editor holds it until the body is in.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || edit.kind !== "reopened" || desk.caret === null) return;
    const timer = setTimeout(() => {
      viewRef.current?.restore({ caret: desk.caret ?? 0, scroll: desk.scrollWriting });
      restored.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [edit.kind, desk.caret, desk.scrollWriting]);

  // Where the operator is, kept while they work, so a quit or a kill leaves the
  // desk pointing at the words and at the place in them.
  useEffect(() => {
    const timer = setInterval(keepPlace, PLACE_EVERY_MS);
    return () => clearInterval(timer);
  }, [keepPlace]);
  // Native quit: the place goes first, then the editor is asked to put every
  // word on disk; its writes ride the canvas flush that follows this commit.
  useEffect(
    () =>
      registerCanvasDraftCommit(() => {
        keepPlace();
        void flushRef.current?.();
      }),
    [keepPlace],
  );

  const focusRow = (id: string | undefined): void => {
    setActive(id);
    keepDesk({ focused: id ?? null });
    const row = rows.find((candidate) => candidate.artifactId === id) ?? rows[0];
    setEdit({ kind: "preview", row });
  };

  const step = useCallback(
    (delta: 1 | -1): void => {
      if (rows.length === 0) return;
      const at = rows.findIndex((row) => row.artifactId === (activeRow?.artifactId ?? active));
      const next = rows[Math.min(Math.max(at + delta, 0), rows.length - 1)];
      if (next !== undefined) focusRow(next.artifactId);
    },
    // focusRow closes over the rows of this render on purpose: the step is one press.
    [rows, active, activeRow?.artifactId],
  );

  /** Leave the surface: the desk and the place are kept, the words are the editor's. */
  const closeCapture = (): void => {
    keepPlace();
    keepDesk({}, true);
    closeOperatorModal("capture");
  };

  const openInNode = (row: CaptureRow | undefined): void => {
    if (row === undefined) return;
    closeCapture();
    focusCanvasNode(row.nodeId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    // The editor is the one scope that owns the bare keys: there M types m and
    // Cmd+Enter follows the link at the caret. Everywhere else in the surface,
    // the search field included, they are the list's.
    const inEditor = (event.target as Element | null)?.closest?.("[data-live-markdown], .live-markdown") != null;
    // The editor owns its keys, but two chords reach past it: another capture,
    // and the search field.
    if (keyIs(event.nativeEvent, "inCapture.new")) {
      event.preventDefault();
      setEdit((prior) => ({ kind: "new", key: (prior.kind === "new" ? prior.key : 0) + 1 }));
      keepDesk({ open: { kind: "new" }, focused: null }, true);
      return;
    }
    if (keyIs(event.nativeEvent, "inCapture.search")) {
      event.preventDefault();
      claimFocus(searchRef.current, "gesture", { event: event.nativeEvent });
      return;
    }
    if (inEditor) return;
    if (keyIs(event.nativeEvent, "inCapture.node")) {
      event.preventDefault();
      openInNode(activeRow);
      return;
    }
    if (keyIs(event.nativeEvent, "inCapture.move")) {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (keyIs(event.nativeEvent, "inCapture.open") && activeRow !== undefined) {
      event.preventDefault();
      setEdit({ kind: "artifact", row: activeRow });
      keepDesk({ open: { kind: "artifact", nodeId: activeRow.nodeId, artifactId: activeRow.artifactId } }, true);
      return;
    }
    // Bare keys: they type in the search field and in the writing, so they act
    // only where no text field has the keyboard. Move to's own buttons take
    // Enter and the arrows first, and those arrive defaultPrevented above.
    if (isOperatorTyping(event.nativeEvent.target)) return;
    if (keyIs(event.nativeEvent, "inCapture.route")) {
      event.preventDefault();
      move.focusFirst();
      return;
    }
    const route = CAPTURE_ROUTES.findIndex((id) => keyIs(event.nativeEvent, id));
    if (route >= 0) {
      event.preventDefault();
      move.choose(route);
    }
  };

  const newCapture = capsOf(keyCaps("inCapture.new"));

  return (
    <OperatorModalShell
      id="capture"
      label="Quick capture"
      width={1280}
      fill
      panelClassName="quick-capture"
      onKeyDown={onKeyDown}
    >
      <div
        className="quick-capture__body"
        // In this surface one Escape closes it, the writing saved (Q6 walk):
        // caught here, before the live field's own stop-writing press.
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          closeCapture();
        }}
      >
        <section className="quick-capture__list" aria-labelledby={`${baseId}-captures`}>
          <h2 className="sr-only" id={`${baseId}-captures`}>Captures</h2>
          <div className="quick-capture__search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              {...comboboxFieldAria(aria)}
              type="search"
              aria-label="Search every artifact"
              placeholder="Search artifacts"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(undefined);
                keepDesk({ query: event.target.value, focused: null });
              }}
            />
            {query === "" ? null : (
              <button
                type="button"
                className="quick-capture__clear"
                aria-label="Clear search"
                // A press must not pull the caret out of the field (Cmd+K's clear).
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  setQuery("");
                  setActive(undefined);
                  keepDesk({ query: "", focused: null }, true);
                  claimFocus(searchRef.current, "gesture", { event });
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {/* The list's own name: group headings name themselves, a search has none. */}
          <span className="sr-only" id={`${baseId}-list-label`}>
            {query.trim() === "" ? "Artifacts" : "Matches"}
          </span>
          <div
            {...listboxAria(aria)}
            className="quick-capture__rows"
            aria-labelledby={`${baseId}-list-label`}
            aria-activedescendant={activeRow === undefined ? undefined : optionId(baseId, activeRow.artifactId)}
            // The list is its own stop: the keys that act on a row, M included,
            // type in the search field, so the keyboard has to be able to sit here.
            // Its focus mark is the active row's ring, not a box around the list
            // (quick-capture.css): the row the keys act on says so.
            tabIndex={0}
          >
            {rows.length === 0 ? (
              <p className="quick-capture__none">
                {query.trim() === "" ? "Nothing captured yet." : "No artifact matches."}
              </p>
            ) : (
              groups.map((group) => (
                <div
                  key={group.key}
                  role="group"
                  {...(group.label === null ? {} : { "aria-labelledby": `${baseId}-group-${group.key}` })}
                >
                  {group.label === null ? null : (
                    <p className="quick-capture__group" id={`${baseId}-group-${group.key}`}>
                      {group.label}
                    </p>
                  )}
                  {group.rows.map((row) => (
                    <div
                      key={row.artifactId}
                      {...optionAria(aria, row.artifactId)}
                      className="quick-capture__row"
                      onPointerMove={() => setActive(row.artifactId)}
                      onClick={() => {
                        setActive(row.artifactId);
                        setEdit({ kind: "artifact", row });
                        keepDesk({ open: { kind: "artifact", nodeId: row.nodeId, artifactId: row.artifactId }, focused: row.artifactId }, true);
                      }}
                    >
                      <ResourceGlyphMark kind="artifact" artifactType={row.type} size={14} />
                      <span className="quick-capture__row-main">
                        <span className="quick-capture__row-title">{rowLabel(row)}</span>
                        {row.detail === "" ? null : (
                          <>
                            {/* A reader hears the title, then the labels, not run together. */}
                            <span className="sr-only">, </span>
                            <span className="quick-capture__row-detail">{row.detail}</span>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
          {/* Mounted for the surface's life, so the line it says is heard: a
              status element added with its own words announces nothing. */}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {rows.length === 0 ? (query.trim() === "" ? "Nothing captured yet." : "No artifact matches.") : ""}
          </span>
        </section>
        <section className="quick-capture__right capture-desk__writing" ref={rightRef} aria-labelledby={`${baseId}-writing`}>
          <h2 className="sr-only" id={`${baseId}-writing`}>Writing</h2>
          {edit.kind === "new" || (edit.kind === "preview" && previewRow === undefined) ? (
            inbox === undefined ? (
              <CaptureInboxAsk
                canvas={canvasName}
                onChosen={() => setEdit({ kind: "new", key: (edit.kind === "new" ? edit.key : 0) + 1 })}
              />
            ) : (
              <CaptureEditor
                canvasName={canvasName}
                inbox={inbox as NodeId}
                open={{ kind: "new", key: edit.kind === "new" ? edit.key : 0 }}
                flushRef={flushRef}
                viewRef={viewRef}
                onArtifact={(ref) => {
                  if (ref !== null) setActive(ref.artifactId);
                  setMade(ref === null ? undefined : { key: edit.kind === "new" ? edit.key : 0, ref });
                  // The first keystroke with words makes the artifact: the desk
                  // points at it at once, so a kill right after it still reopens
                  // the words rather than a blank capture.
                  keepDesk(
                    {
                      open: ref === null ? { kind: "new" } : { kind: "artifact", nodeId: ref.nodeId, artifactId: ref.artifactId },
                      ...(ref === null ? {} : { focused: ref.artifactId }),
                    },
                    true,
                  );
                }}
              />
            )
          ) : null}
          {edit.kind === "artifact" || edit.kind === "reopened" ? (
            <CaptureEditor
              canvasName={canvasName}
              inbox={inbox as NodeId | undefined}
              open={
                edit.kind === "artifact"
                  ? { kind: "artifact", nodeId: edit.row.nodeId, artifactId: edit.row.artifactId as ItemId }
                  : { kind: "artifact", nodeId: edit.nodeId as NodeId, artifactId: edit.artifactId as ItemId }
              }
              flushRef={flushRef}
              viewRef={viewRef}
              onArtifact={(ref) => {
                if (ref === null) return;
                setActive(ref.artifactId);
                keepDesk({ open: { kind: "artifact", nodeId: ref.nodeId, artifactId: ref.artifactId } }, true);
              }}
            />
          ) : null}
          {edit.kind === "preview" && previewRow !== undefined ? (
            <div className="quick-capture__preview quick-capture__preview--row">
              {/* The editor's head, read only: Enter swaps the body, never the layout. */}
              <header className="artifact-head capture-editor__head">
                <ResourceGlyphMark kind="artifact" artifactType={previewRow.type} size={14} />
                {/* Read only, and not a stop: the preview is a look, not a field. */}
                <input className="artifact-head__title" aria-label="Title" value={rowLabel(previewRow)} readOnly tabIndex={-1} />
              </header>
              <div className="quick-capture__preview-body">
                <CapturePreview
                  key={`${previewRow.artifactId}:${String(previewRow.updatedAt)}`}
                  row={previewRow}
                  canvasName={canvasName}
                />
              </div>
            </div>
          ) : null}
        </section>
        <section className="quick-capture__move capture-desk__move" aria-labelledby={`${baseId}-move`}>
          <h2 className="quick-capture__move-head" id={`${baseId}-move`}>
            Move to
          </h2>
          <CaptureMoveColumn move={move} canvasName={canvasName} />
        </section>
      </div>
      <div className="quick-capture__foot">
        <span className="quick-capture__hint">
          <Kbd>↑↓</Kbd> list
        </span>
        <span className="quick-capture__hint">
          <Kbd>↵</Kbd> edit
        </span>
        <span className="quick-capture__hint">
          <Kbd>{capsOf(keyCaps("inCapture.route")) ?? "M"}</Kbd> move
        </span>
        {newCapture === undefined ? null : (
          <span className="quick-capture__hint">
            <Kbd>{newCapture}</Kbd> new capture
          </span>
        )}
        <span className="quick-capture__hint">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </OperatorModalShell>
  );
}
