import { useCallback, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { FileText, Search } from "lucide-react";
import { claimFocus } from "../../lib/focus-ownership";
import { keyIs } from "../../lib/key-match";
import { useCanvasArtifacts } from "../../lib/capture-artifacts";
import { useCaptureInbox } from "../../lib/capture-inbox";
import { state$ } from "../../lib/state";
import { closeOperatorModal } from "../../lib/operator-modal";
import { focusCanvasNode } from "../../lib/command-bar";
import { LiveMarkdownField } from "../artifacts/LiveMarkdownField";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { Kbd } from "../ui";
import { CaptureInboxAsk } from "./CaptureInboxAsk";
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

/** The stand-in capture editor until Q2's CaptureEditor lands: a live document, kept in memory. */
function CaptureStandIn({ captureKey }: { readonly captureKey: number }) {
  const [text, setText] = useState("");
  return (
    <div className="quick-capture__write" data-capture-entry="">
      <LiveMarkdownField
        key={captureKey}
        value={text}
        onChange={setText}
        label="Capture"
        surfaceLabel="New capture, document"
        placeholder="Write anything."
      />
    </div>
  );
}

const rowLabel = (row: CaptureRow): string => row.title === "" ? "Untitled" : row.title;

export function QuickCapture() {
  const canvasName = use$(state$.canvasName);
  const heads = useCanvasArtifacts(canvasName);
  const inbox = useCaptureInbox(canvasName);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [edit, setEdit] = useState<Edit>({ kind: "new", key: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => captureRowsOf(heads, undefined, query), [heads, query]);
  const activeRow = rows.find((row) => row.artifactId === active) ?? rows[0];

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
    }
  };

  return (
    <OperatorModalShell
      id="capture"
      label="Quick capture"
      title="Quick capture"
      fill
      panelClassName="quick-capture"
      onKeyDown={onKeyDown}
    >
      <div className="quick-capture__body">
        <div className="quick-capture__list">
          <div className="quick-capture__search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search every artifact"
              placeholder="Search every artifact"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(undefined);
              }}
            />
          </div>
          <p className="quick-capture__list-label" id="quick-capture-list-label">
            {query.trim() === "" ? "Inbox, then recent" : "Matches"}
          </p>
          <ul className="quick-capture__rows" aria-labelledby="quick-capture-list-label">
            {rows.length === 0 ? (
              <li className="quick-capture__none" role="status">
                {query.trim() === "" ? "Nothing captured yet." : "No artifact matches."}
              </li>
            ) : (
              rows.map((row) => (
                <li key={row.artifactId}>
                  <button
                    type="button"
                    className="quick-capture__row"
                    aria-current={row.artifactId === activeRow?.artifactId ? "true" : undefined}
                    onClick={() => {
                      setActive(row.artifactId);
                      setEdit({ kind: "artifact", row });
                    }}
                    onDoubleClick={() => setEdit({ kind: "artifact", row })}
                  >
                    <FileText size={13} aria-hidden />
                    <span className="quick-capture__row-main">
                      <span className="quick-capture__row-title">{rowLabel(row)}</span>
                      <span className="quick-capture__row-detail">{row.detail}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="quick-capture__right">
          {edit.kind === "new" ? (
            inbox === undefined ? (
              <CaptureInboxAsk canvas={canvasName} onChosen={() => setEdit({ kind: "new", key: edit.key + 1 })} />
            ) : (
              <CaptureStandIn captureKey={edit.key} />
            )
          ) : null}
          {edit.kind === "artifact" ? (
            <div className="quick-capture__edit" data-capture-entry="">
              <LiveMarkdownField
                key={edit.row.artifactId}
                value={edit.row.head.body?.type === "document" ? edit.row.head.body.markdown : ""}
                label={rowLabel(edit.row)}
                surfaceLabel={`${rowLabel(edit.row)}, ${edit.row.type}`}
                readOnly
              />
            </div>
          ) : null}
          {edit.kind === "preview" ? (
            <div className="quick-capture__preview">
              <p className="quick-capture__preview-title">{edit.row === undefined ? "Start writing" : rowLabel(edit.row)}</p>
              <p className="quick-capture__preview-detail">
                {edit.row === undefined ? "Cmd+T captures anywhere. What you write stays." : edit.row.detail}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <div className="quick-capture__foot">
        <span className="quick-capture__hint">
          <Kbd>↑↓</Kbd> preview
        </span>
        <span className="quick-capture__hint">
          <Kbd>↵</Kbd> edit
        </span>
        <span className="quick-capture__hint">
          <Kbd>⌘N</Kbd> new capture
        </span>
        <span className="quick-capture__hint">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </OperatorModalShell>
  );
}
