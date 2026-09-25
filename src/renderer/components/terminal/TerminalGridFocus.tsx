import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { terminalSettings } from "@shared/settings";
import { state$ } from "../../lib/state";
import {
  registerGridTerminalSlot,
  setGridTerminalCell,
  terminal$,
} from "../../lib/terminal-state";
import {
  closeTerminalGrid,
  setTerminalGridChoice,
  setTerminalGridPage,
  terminalGrid$,
} from "../../lib/terminal-grid-state";
import {
  gridOverflowCopy,
  gridPageRange,
  gridShapeKey,
  layoutGrid,
  pickableGridShapes,
  type GridArea,
  type GridChoice,
} from "../../lib/terminal-grid";
import { FocusSurface } from "../FocusSurface";
import { Button, Dropdown, Kbd, OverlayHeader, type DropdownOption } from "../ui";

/**
 * Grid focus: the selected agents' live terminals side by side.
 *
 * Each cell adopts the seat's one persistent TerminalSurface (never a second
 * xterm on the same PTY), with a grid-only font and inset that lift off when
 * the cell lets go. Escape stays with a focused terminal, as in the single
 * focus view; it closes the grid when no cell holds the keyboard.
 */
export function TerminalGridFocus() {
  const nodeIds = use$(terminalGrid$.nodeIds);
  if (nodeIds.length === 0) return null;
  return <TerminalGridModal nodeIds={nodeIds} />;
}

const agentCount = (count: number): string => `${count} agent${count === 1 ? "" : "s"}`;

function TerminalGridModal({ nodeIds }: { readonly nodeIds: ReadonlyArray<string> }) {
  const choice = use$(terminalGrid$.choice);
  const page = use$(terminalGrid$.page);
  const settings = use$(state$.settings);
  const prefs = terminalSettings(settings);
  const fontSize = prefs.fontSize;
  const lineHeight = prefs.lineHeight;
  const count = nodeIds.length;

  const cellsRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<GridArea | null>(null);
  useLayoutEffect(() => {
    const cells = cellsRef.current;
    if (!cells) return;
    const read = (): void => {
      const style = getComputedStyle(cells);
      const width =
        cells.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        cells.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setArea((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(cells);
    return () => observer.disconnect();
  }, []);

  const layout = area
    ? layoutGrid({ count, area, prefs: { fontSize, lineHeight }, choice })
    : null;
  const range = layout ? gridPageRange(page, layout.pageSize, count) : { start: 0, end: 0 };
  const shown = nodeIds.slice(range.start, range.end);
  const overflow = gridOverflowCopy(range, count);
  const gridFont = layout?.fontSize;
  const shownKey = shown.join("\n");

  // Grid-only view options for the cells on screen; everyone else lets go
  // and gets the operator's own options back.
  useEffect(() => {
    if (gridFont === undefined) return;
    const onScreen = new Set(shownKey.split("\n"));
    for (const id of nodeIds) {
      setGridTerminalCell(id, onScreen.has(id) ? { fontSize: gridFont } : null);
    }
  }, [nodeIds, shownKey, gridFont]);

  // Escape belongs to a focused terminal (agent TUIs use it). With no cell
  // holding the keyboard, it closes the grid. Inner layers (the shape menu)
  // capture and consume their own Escape first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".terminal-grid__cell")) return;
      event.preventDefault();
      closeTerminalGrid();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const offered = area ? pickableGridShapes(count, area, { fontSize, lineHeight }) : [];
  const shapeOptions: DropdownOption[] = [
    { value: "auto", label: layout && choice === "auto" ? `auto (${gridShapeKey(layout.shape)})` : "auto" },
    ...offered.map((shape) => ({
      value: gridShapeKey(shape),
      label: `${gridShapeKey(shape)} (${shape.rows} row${shape.rows === 1 ? "" : "s"}, ${shape.cols} col${shape.cols === 1 ? "" : "s"})`,
    })),
  ];
  if (choice !== "auto" && !shapeOptions.some((option) => option.value === choice)) {
    shapeOptions.push({ value: choice, label: `${choice} (too small here)` });
  }

  const pageCount = layout?.pageCount ?? 1;
  const status = [
    overflow
      ? `${overflow}, cells would be too small to read with everyone at once`
      : layout && !layout.readable
        ? "cells are below readable size, pick a larger shape or widen the window"
        : null,
    layout && gridFont !== undefined && gridFont < fontSize ? `grid font ${gridFont}px` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label={`Grid focus, ${agentCount(count)}`}
      onClose={closeTerminalGrid}
      closeOnEscape={false}
      closeOnBackdrop
      claimFocusOnOpen={false}
      panelClassName="terminal-grid__panel"
    >
      <div className="terminal-grid" data-testid="terminal-grid-focus">
        <OverlayHeader
          eyebrow="grid focus"
          title={agentCount(count)}
          status={
            <span className="inline-flex items-center gap-1.5">
              {status ? <span className="text-amber">{status},</span> : null}
              <span>click a cell to type,</span>
              <Kbd>Esc</Kbd>
              <span>closes when no cell has focus</span>
            </span>
          }
          actions={
            <>
              {pageCount > 1 ? (
                <>
                  <Button
                    size="xs"
                    variant="chrome"
                    aria-label="Previous page"
                    disabled={page <= 0}
                    onClick={() => setTerminalGridPage(page - 1)}
                  >
                    Prev
                  </Button>
                  <span className="font-mono text-[11px] text-dim">
                    page {Math.min(page, pageCount - 1) + 1} of {pageCount}
                  </span>
                  <Button
                    size="xs"
                    variant="chrome"
                    aria-label="Next page"
                    disabled={page >= pageCount - 1}
                    onClick={() => setTerminalGridPage(page + 1)}
                  >
                    Next
                  </Button>
                </>
              ) : null}
              <Dropdown
                aria-label="Grid shape"
                title="Grid shape, rows x columns"
                value={choice}
                options={shapeOptions}
                onChange={(value) => setTerminalGridChoice(value as GridChoice)}
              />
              <Button
                size="xs"
                variant="primary"
                title="Close grid, processes keep running"
                aria-label="Close grid"
                onClick={closeTerminalGrid}
              >
                Close
              </Button>
            </>
          }
        />
        <div
          ref={cellsRef}
          className="terminal-grid__cells"
          style={
            layout
              ? {
                  gridTemplateColumns: `repeat(${layout.shape.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${layout.shape.rows}, minmax(0, 1fr))`,
                }
              : undefined
          }
        >
          {layout ? shown.map((nodeId) => <TerminalGridCell key={nodeId} nodeId={nodeId} />) : null}
        </div>
      </div>
    </FocusSurface>
  );
}

function TerminalGridCell({ nodeId }: { readonly nodeId: string }) {
  const open = use$(() => terminal$.openByNodeId[nodeId].get() !== undefined);
  const cellRef = useRef<HTMLDivElement | null>(null);
  const setCell = useCallback(
    (element: HTMLDivElement | null) => {
      cellRef.current = element;
      registerGridTerminalSlot(nodeId, element);
    },
    [nodeId],
  );

  // The terminal is adopted DOM, so React handlers here never see its
  // events. A native listener turns a click on the cell header into keyboard
  // focus on that cell's terminal; clicks inside the xterm focus it already.
  useEffect(() => {
    const cell = cellRef.current;
    if (!cell) return;
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest("button, a, input, textarea")) return;
      requestAnimationFrame(() => {
        if (cell.contains(document.activeElement)) return;
        cell.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
      });
    };
    cell.addEventListener("mousedown", onMouseDown);
    return () => cell.removeEventListener("mousedown", onMouseDown);
  }, []);

  return (
    <div ref={setCell} className="terminal-grid__cell" data-node-id={nodeId}>
      {open ? null : (
        <div className="terminal-grid__cell-empty text-[12px] text-dim">
          This seat has no live terminal view.
        </div>
      )}
    </div>
  );
}
