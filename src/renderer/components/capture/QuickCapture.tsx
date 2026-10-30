import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { FileText, Search } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/resource-command";
import { claimFocus, isOperatorTyping } from "../../lib/focus-ownership";
import { keyIs, keyCaps } from "../../lib/key-match";
import { isMac } from "../../lib/platform";
import { useCanvasArtifacts } from "../../lib/capture-artifacts";
import { useCaptureInbox } from "../../lib/capture-inbox";
import { state$ } from "../../lib/state";
import { closeOperatorModal } from "../../lib/operator-modal";
import { focusCanvasNode } from "../../lib/command-bar";
import { useCanvas } from "../../lib/use-model";
import {
  comboboxFieldAria,
  listboxAria,
  optionAria,
  optionId,
  type ListboxAriaState,
} from "../../lib/listbox-aria";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { ArtifactMoveDialog } from "../artifacts/ArtifactMove";
import { Kbd } from "../ui";
import { CaptureEditor } from "./CaptureEditor";
import { CapturePreview } from "./CapturePreview";
import { CaptureInboxAsk } from "./CaptureInboxAsk";
import { moveSuggestionsFor } from "./capture-model";
import { captureRowsOf, type CaptureRow } from "./capture-list";
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
  | { readonly kind: "preview"; readonly row: CaptureRow | undefined };

/** A chord as its key caps in one word: "⌘N" on macOS, "Ctrl+N" elsewhere. */
const capsOf = (caps: readonly string[] | undefined): string | undefined =>
  caps === undefined ? undefined : caps.join(isMac() ? "" : "+");

const rowLabel = (row: CaptureRow): string => (row.title === "" ? "Untitled" : row.title);

export function QuickCapture() {
  const canvasName = use$(state$.canvasName);
  const heads = useCanvasArtifacts(canvasName);
  const inbox = useCaptureInbox(canvasName);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [edit, setEdit] = useState<Edit>({ kind: "new", key: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const rows = useMemo(
    () => captureRowsOf(heads, inbox as NodeId | undefined, query),
    [heads, inbox, query],
  );
  const activeRow = rows.find((row) => row.artifactId === active) ?? rows[0];
  // The row as it is now, not the snapshot taken when it was picked: a body
  // that changed under an open preview still reads its newest text.
  const previewRow =
    edit.kind === "preview" && edit.row !== undefined
      ? rows.find((row) => row.artifactId === edit.row!.artifactId) ?? edit.row
      : undefined;
  // The open Move to, and the routes it offers: where this artifact's links,
  // mentions and labels point, and the node holding the artifacts most like it.
  const [routing, setRouting] = useState<CaptureRow | undefined>(undefined);
  const canvas = useCanvas(canvasName);
  const routes = useMemo(
    () => (routing === undefined ? [] : moveSuggestionsFor(canvas, routing.head, heads)),
    [routing, canvas, heads],
  );
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
  const openKey = edit.kind === "new" ? `new-${String(edit.key)}` : edit.kind === "artifact" ? edit.row.artifactId : "preview";
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

  const focusRow = (id: string | undefined): void => {
    setActive(id);
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

  const openInNode = (row: CaptureRow | undefined): void => {
    if (row === undefined) return;
    closeOperatorModal("capture");
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
      return;
    }
    // A bare key: it types in the search field, so it routes only from the
    // list itself, where the keyboard steps in with Tab.
    if (keyIs(event.nativeEvent, "inCapture.route") && !isOperatorTyping(event.nativeEvent.target) && activeRow !== undefined) {
      event.preventDefault();
      setRouting(activeRow);
    }
  };

  const newCapture = capsOf(keyCaps("inCapture.new"));

  return (
    <OperatorModalShell
      id="capture"
      label="Quick capture"
      title="Quick capture"
      width={760}
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
          closeOperatorModal("capture");
        }}
      >
        <div className="quick-capture__list">
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
              }}
            />
          </div>
          <p className="quick-capture__list-label" id={`${baseId}-label`}>
            {query.trim() === "" ? "Inbox, then recent" : "Matches"}
          </p>
          <ul
            {...listboxAria(aria)}
            className="quick-capture__rows junto-focus-ring"
            aria-labelledby={`${baseId}-label`}
            aria-activedescendant={activeRow === undefined ? undefined : optionId(baseId, activeRow.artifactId)}
            // The list is its own stop: the keys that act on a row, M included,
            // type in the search field, so the keyboard has to be able to sit here.
            tabIndex={0}
          >
            {rows.length === 0 ? (
              <li className="quick-capture__none" role="status">
                {query.trim() === "" ? "Nothing captured yet." : "No artifact matches."}
              </li>
            ) : (
              rows.map((row) => (
                <li
                  key={row.artifactId}
                  {...optionAria(aria, row.artifactId)}
                  className="quick-capture__row"
                  onClick={() => {
                    setActive(row.artifactId);
                    setEdit({ kind: "artifact", row });
                  }}
                >
                  <FileText size={13} aria-hidden />
                  <span className="quick-capture__row-main">
                    <span className="quick-capture__row-title">{rowLabel(row)}</span>
                    {/* A reader hears the title, then the type and labels, not run together. */}
                    <span className="sr-only">, </span>
                    <span className="quick-capture__row-detail">{row.detail}</span>
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="quick-capture__right" ref={rightRef}>
          {edit.kind === "new" ? (
            inbox === undefined ? (
              <CaptureInboxAsk canvas={canvasName} onChosen={() => setEdit({ kind: "new", key: edit.key + 1 })} />
            ) : (
              <CaptureEditor
                canvasName={canvasName}
                inbox={inbox as NodeId}
                open={{ kind: "new", key: edit.key }}
                onArtifact={(ref) => {
                  if (ref !== null) setActive(ref.artifactId);
                }}
              />
            )
          ) : null}
          {edit.kind === "artifact" ? (
            <CaptureEditor
              canvasName={canvasName}
              inbox={inbox as NodeId | undefined}
              open={{ kind: "artifact", nodeId: edit.row.nodeId, artifactId: edit.row.artifactId as ItemId }}
            />
          ) : null}
          {edit.kind === "preview" ? (
            previewRow === undefined ? (
              <div className="quick-capture__preview">
                <p className="quick-capture__preview-title">Start writing</p>
                <p className="quick-capture__preview-detail">What you write here stays.</p>
              </div>
            ) : (
              <div className="quick-capture__preview quick-capture__preview--row">
                <p className="quick-capture__preview-title">{rowLabel(previewRow)}</p>
                <p className="quick-capture__preview-detail">{previewRow.detail}</p>
                <div className="quick-capture__preview-body">
                  <CapturePreview
                    key={`${previewRow.artifactId}:${String(previewRow.updatedAt)}`}
                    row={previewRow}
                    canvasName={canvasName}
                  />
                </div>
              </div>
            )
          ) : null}
        </div>
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
      {routing === undefined ? null : (
        <ArtifactMoveDialog
          canvasName={canvasName}
          from={routing.nodeId}
          artifacts={[{ artifactId: routing.artifactId as ItemId, title: rowLabel(routing) }]}
          suggestions={routes}
          onCancel={() => setRouting(undefined)}
          onDone={() => setRouting(undefined)}
        />
      )}
    </OperatorModalShell>
  );
}
