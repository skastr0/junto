import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import { FIRST_ARTIFACT_VERSION } from "@shared/artifact";
import { applyArtifactOp, useHeadBody } from "../../lib/artifacts-source";
import { useCanvasArtifacts } from "../../lib/mention-items";
import { claimFocus } from "../../lib/focus-ownership";
import { keyCaps } from "../../lib/key-match";
import { isMac } from "../../lib/platform";
import { useCanvas } from "../../lib/use-model";
import { Kbd } from "../ui";
import { FOCUS_RING_INSET } from "../ui/focus";
import { ArtifactMoveDialog } from "../artifacts/ArtifactMove";
import { movedLine, moveTargets, reachChange, reachLine, suggestedFirst } from "../artifacts/artifact-move-model";
import type { CaptureArtifactRef } from "./CaptureEditor";
import { moveSuggestionsFor } from "./capture-model";
import "./capture-move.css";

/** The desk's routes, each on its own key from the key table (1, 2 and 3 unless rebound). */
const ROUTE_KEYS = ["inCapture.route1", "inCapture.route2", "inCapture.route3"] as const;
const ROUTES = ROUTE_KEYS.length;

/** Route `i`'s key caps as one word, as the footer writes a chord; its number when the table has no row. */
const routeCap = (i: number): string => {
  const id = ROUTE_KEYS[i];
  return (id === undefined ? undefined : keyCaps(id)?.join(isMac() ? "" : "+")) ?? String(i + 1);
};

const NO_ANSWER = "Junto got no answer for that move. Try again.";

/** A head to read when there is none: its body is held, so nothing is fetched for it. */
const NO_HEAD = {
  artifact: { artifactId: "", version: FIRST_ARTIFACT_VERSION },
  body: { type: "document", markdown: "" },
  bodyRef: null,
} as unknown as ArtifactHead;

/** One route the column offers: an Artifacts node, and the one line that says why. */
export type CaptureRoute = { readonly id: NodeId; readonly title: string; readonly why: string };

/**
 * The Move to column (0.12, the Cmd+T desk), as the surface holds it: the
 * keys reach it through these calls, and the column draws it.
 */
export type CaptureMove = {
  /** What moves, on the node the canvas lists it on now: the open capture, or the focused row; undefined while nothing saved is open. */
  readonly target: CaptureArtifactRef | undefined;
  /** Up to three, best first. */
  readonly routes: ReadonlyArray<CaptureRoute>;
  /** The route wearing the wash: it follows focus and the pointer, and Enter takes it. */
  readonly picked: number;
  /** A route into another region, waiting for its second press; its reach line is said. */
  readonly armed: NodeId | null;
  /** The reach line while armed, else how the last move went. */
  readonly line: string | null;
  readonly busy: boolean;
  /** Move to route `i`. Into another region the first press arms it and says whose reach changes; the second moves. */
  readonly choose: (i: number) => void;
  readonly pick: (i: number) => void;
  /** The keyboard to the first route, or to Other when there is none. */
  readonly focus: () => void;
  /** The full picker, its routes first. */
  readonly other: () => void;
  readonly otherOpen: boolean;
  readonly closeOther: (moved: string | null) => void;
  readonly title: string;
  readonly columnRef: RefObject<HTMLDivElement | null>;
};

/**
 * Where a capture could go, and the moves there (docs/plans/0.11/11-quick-capture.md,
 * Q5, on the desk). Routes are read from where the artifact's links, mentions
 * and labels point, and from the node holding the artifacts most like it.
 * Nothing moves on its own: a route moves on a press, and a route that changes
 * whose reach it is in takes a second press after its line is said.
 */
export function useCaptureMove(canvasName: string, target: CaptureArtifactRef | undefined): CaptureMove {
  const canvas = useCanvas(canvasName);
  const everything = useCanvasArtifacts(canvasName);
  const head = target === undefined ? undefined : everything.find((one) => one.artifact.artifactId === target.artifactId);
  const body = useHeadBody(canvasName, head ?? NO_HEAD);
  // Where it is now, as the canvas lists it: a move lands before the caller's target catches up.
  const from = (head?.artifact.nodeId ?? target?.nodeId) as NodeId | undefined;
  const title = head?.artifact.title ?? "";

  const routes = useMemo<ReadonlyArray<CaptureRoute>>(() => {
    if (head === undefined || from === undefined) return [];
    const suggested = moveSuggestionsFor(canvas, head, everything, body?.type === "document" ? body.markdown : undefined);
    return suggestedFirst(moveTargets(canvas, from), suggested)
      .filter((one) => one.suggested !== undefined)
      .slice(0, ROUTES)
      .map((one) => ({ id: one.id, title: one.title, why: one.suggested! }));
  }, [canvas, head, everything, body, from]);

  const [picked, setPicked] = useState(0);
  const [armed, setArmed] = useState<NodeId | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const running = useRef(false);

  // Another artifact is another triage: nothing armed or said carries over.
  const key = target === undefined ? "" : target.artifactId;
  useEffect(() => {
    setPicked(0);
    setArmed(null);
    setSaid(null);
  }, [key]);
  // An armed route that is no longer offered is no longer armed.
  useEffect(() => {
    if (armed !== null && !routes.some((one) => one.id === armed)) setArmed(null);
  }, [routes, armed]);

  const move = async (to: CaptureRoute): Promise<void> => {
    if (target === undefined || from === undefined || running.current) return;
    running.current = true;
    setBusy(true);
    setArmed(null);
    try {
      const ruling = await applyArtifactOp(canvasName, from, target.artifactId, { op: "move", to: to.id });
      setSaid(ruling.kind === "refused" ? `${title} was not moved: ${ruling.error.message}` : movedLine([title], ruling.kind === "queued" ? 1 : 0, to.title));
    } catch {
      setSaid(`${title} was not moved: ${NO_ANSWER}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const choose = (i: number): void => {
    const to = routes[i];
    if (to === undefined || from === undefined || running.current) return;
    setPicked(i);
    const line = reachLine(reachChange(canvas, from, to.id), 1);
    if (line !== null && armed !== to.id) {
      setArmed(to.id);
      return;
    }
    void move(to);
  };

  const focus = useCallback((): void => {
    const first = columnRef.current?.querySelector<HTMLElement>("[data-capture-move-option]");
    if (first != null) claimFocus(first, "gesture");
  }, []);

  const armedRoute = routes.find((one) => one.id === armed);
  const line = armedRoute !== undefined && from !== undefined ? reachLine(reachChange(canvas, from, armedRoute.id), 1) : said;

  return {
    target: head === undefined || target === undefined || from === undefined ? undefined : { nodeId: from, artifactId: target.artifactId },
    routes,
    picked: Math.min(picked, Math.max(routes.length - 1, 0)),
    armed,
    line,
    busy,
    choose,
    pick: (i) => {
      if (i !== picked) setPicked(i);
    },
    focus,
    other: () => {
      if (head !== undefined && !running.current) setOtherOpen(true);
    },
    otherOpen,
    closeOther: (moved) => {
      setOtherOpen(false);
      if (moved !== null) setSaid(moved);
    },
    title,
    columnRef,
  };
}

/**
 * The desk's right column: up to three routes, each with its number and why,
 * then the full picker. Each is a stop in order; arrows move between them;
 * Enter, Space or a press moves there. The picked route wears an amber wash
 * in a full amber frame, its state, beside the focus ring, never one edge.
 */
export function CaptureMoveColumn({ move, canvasName }: { readonly move: CaptureMove; readonly canvasName: string }) {
  const { target, routes } = move;
  const keys = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const stops = [...(move.columnRef.current?.querySelectorAll<HTMLElement>("[data-capture-move-option], [data-capture-move-other]") ?? [])];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = stops[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), stops.length - 1)];
      if (next != null) claimFocus(next, "gesture", { event: event.nativeEvent });
      return;
    }
    // The button's own press, kept from the surface, where Enter edits the focused row.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (at < routes.length) move.choose(at);
      else move.other();
    }
  };

  return (
    <div className="capture-move" ref={move.columnRef}>
      {target === undefined ? (
        <p className="capture-move__none">A capture can move once it is saved. Write something first.</p>
      ) : (
        <>
          {routes.length === 0 ? (
            <p className="capture-move__none">No suggestion yet: nothing it links, mentions or is labelled with points to another node.</p>
          ) : (
            <div className="capture-move__routes">
              {routes.map((route, i) => (
                <button
                  key={route.id}
                  type="button"
                  data-testid={`capture-move-suggestion-${String(i)}`}
                  data-capture-move-option=""
                  data-picked={i === move.picked ? "true" : undefined}
                  data-armed={route.id === move.armed ? "true" : undefined}
                  aria-disabled={move.busy}
                  className={`capture-move__route outline-none ${FOCUS_RING_INSET}`}
                  onFocus={() => move.pick(i)}
                  onPointerEnter={() => move.pick(i)}
                  onClick={() => move.choose(i)}
                  onKeyDown={(event) => keys(event, i)}
                >
                  <Kbd className="capture-move__key">{routeCap(i)}</Kbd>
                  <span className="capture-move__name">{route.title}</span>
                  <span className="capture-move__why">{route.why}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            data-testid="capture-move-other"
            data-capture-move-other=""
            {...(routes.length === 0 ? { "data-capture-move-option": "" } : {})}
            aria-haspopup="dialog"
            aria-disabled={move.busy}
            className={`capture-move__other outline-none ${FOCUS_RING_INSET}`}
            onClick={move.other}
            onKeyDown={(event) => keys(event, routes.length)}
          >
            Other Artifacts node…
          </button>
        </>
      )}
      {/* Mounted for the column's life, so each line is heard as it changes. */}
      <p className="capture-move__line" role="status" aria-live="polite" aria-atomic="true">
        {move.line ?? ""}
      </p>
      {move.otherOpen && target !== undefined ? (
        <ArtifactMoveDialog
          canvasName={canvasName}
          from={target.nodeId}
          artifacts={[{ artifactId: target.artifactId, title: move.title }]}
          suggestions={routes.map((route) => ({ nodeId: route.id, why: route.why }))}
          onCancel={() => move.closeOther(null)}
          onDone={(done) => move.closeOther(movedLine(done.titles, done.queued, done.to.title))}
        />
      ) : null}
    </div>
  );
}
