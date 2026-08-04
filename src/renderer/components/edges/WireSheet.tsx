/**
 * Dynamic edge config sheet — sections from family + node contracts.
 */
import { useState } from "react";
import type {
  CanvasEdge,
  CanvasNode,
  EdgeCriteria,
  EtherFlag,
  WatchWhen,
  WatchWhenAtom,
} from "@shared/canvas";
import {
  familyFromSlot,
  resolveSpec,
  roleOf,
  sheetSectionsFor,
  sheetTitleFor,
  wirePresentation,
  wireRolePair,
  type ContractEvent,
  type SheetSection,
  type WireFamily,
} from "@shared/physics";
import {
  EdgeBoardNotifyToggle,
  EdgePortsAttenuator,
} from "../InspectorFields";
import { Select } from "../ui";
import { setEdgeCriteria, setEdgeEffect, setEdgeWhen } from "../../lib/edge-mutations";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { HUE, withAlpha } from "../../lib/theme";

export const resolveEdgeFamily = (
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): WireFamily | undefined => {
  const fromSpec = resolveSpec({
    isGroup: fromNode?.type === "group",
    kind: fromNode?.ether?.entity?.kind,
  });
  const toSpec = resolveSpec({
    isGroup: toNode?.type === "group",
    kind: toNode?.ether?.entity?.kind,
  });
  const fromRole = roleOf(fromSpec);
  const toRole = roleOf(toSpec);
  return (
    familyFromSlot(edge.ether?.slot, wireRolePair(fromRole, toRole)) ??
    (fromRole === "actor" || toRole === "actor" ? "access" : undefined)
  );
};

export const edgeSheetTitle = (
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): string => {
  const family = resolveEdgeFamily(edge, fromNode, toNode);
  return family ? sheetTitleFor(family) : "Link";
};

export const edgeSheetSentence = (
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): string | undefined => {
  const family = resolveEdgeFamily(edge, fromNode, toNode);
  if (!family) return undefined;
  return wirePresentation({
    family,
    ether: edge.ether,
    fromKind: fromNode?.ether?.entity?.kind,
    toKind: toNode?.ether?.entity?.kind,
  }).sentence;
};

const atomKey = (atom: WatchWhenAtom): string =>
  atom.word === "flagged" ? `flagged:${atom.flag}` : "completes";

const eventToAtom = (event: ContractEvent): WatchWhenAtom => {
  if (event.word === "flagged" && event.flag) {
    return { word: "flagged", flag: event.flag };
  }
  return { word: "completes" };
};

const atomsFromWhen = (when: WatchWhen | undefined): ReadonlyArray<WatchWhenAtom> => {
  if (!when) return [];
  if (when.word === "any") return when.any;
  if (when.word === "completes" || when.word === "flagged") return [when];
  return [];
};

const whenFromAtoms = (atoms: ReadonlyArray<WatchWhenAtom>): WatchWhen | undefined => {
  if (atoms.length === 0) return undefined;
  if (atoms.length === 1) return atoms[0];
  return { word: "any", any: [...atoms] };
};

function WhenSection({
  edgeId,
  section,
  edge,
}: {
  readonly edgeId: string;
  readonly section: Extract<SheetSection, { readonly _tag: "when" }>;
  readonly edge: CanvasEdge;
}) {
  const active = new Set(atomsFromWhen(edge.ether?.when).map(atomKey));

  const toggle = (event: ContractEvent): void => {
    const atom = eventToAtom(event);
    const key = atomKey(atom);
    const current = atomsFromWhen(edge.ether?.when);
    const next = active.has(key)
      ? current.filter((a) => atomKey(a) !== key)
      : [...current, atom];
    const seen = new Set<string>();
    const deduped: WatchWhenAtom[] = [];
    for (const a of next) {
      const k = atomKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(a);
    }
    setEdgeWhen(edgeId, whenFromAtoms(deduped));
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Fires when</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        Any selected condition (OR)
      </div>
      <div className="inspector-flags" role="list" aria-label="Watch conditions">
        {section.events.map((event) => {
          const atom = eventToAtom(event);
          const key = atomKey(atom);
          const on = active.has(key);
          return (
            <button
              key={event.id}
              type="button"
              role="listitem"
              aria-pressed={on}
              className="inspector-flag-toggle"
              style={{
                color: on ? HUE.cyan : "#68604a",
                borderColor: on ? withAlpha(HUE.cyan, 0.5) : "rgba(237,230,218,.12)",
                background: on ? withAlpha(HUE.cyan, 0.1) : "rgba(255,255,255,.02)",
              }}
              onClick={() => toggle(event)}
            >
              {event.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DoesSection({
  edgeId,
  section,
  edge,
  toNode,
}: {
  readonly edgeId: string;
  readonly section: Extract<SheetSection, { readonly _tag: "does" }>;
  readonly edge: CanvasEdge;
  readonly toNode: CanvasNode | undefined;
}) {
  const effect = edge.ether?.does ?? edge.ether?.effect;
  const mode = effect?.mode ?? "none";
  const options = [
    { value: "none", label: "Do nothing" },
    ...section.inputs.map((input) => ({
      value: input.mode,
      label: input.label,
    })),
  ];

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Then</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        Applied to {toNode ? nodeTitle(toNode) : "the other end"}
      </div>
      <label className="inspector-editor">
        <span>Action</span>
        <Select
          dense
          aria-label="Action when this fires"
          value={mode}
          options={options}
          onChange={(value) => {
            if (value === "none") {
              setEdgeEffect(edgeId, undefined);
              return;
            }
            if (value === "enqueue_task") {
              setEdgeEffect(edgeId, {
                mode: "enqueue_task",
                brief: "Scheduled work",
                reason: "scheduler",
              });
              return;
            }
            if (value === "inject_prompt") {
              setEdgeEffect(edgeId, { mode: "inject_prompt" });
              return;
            }
            setEdgeEffect(edgeId, {
              mode: "set_flag",
              flag: "attention",
              enabled: true,
            });
          }}
        />
      </label>
      {effect?.mode === "set_flag" ? (
        <label className="inspector-editor">
          <span>Flag</span>
          <Select
            dense
            aria-label="Flag to set"
            value={effect.flag}
            options={[
              { value: "blocker", label: "Blocker" },
              { value: "attention", label: "Needs attention" },
              { value: "parked", label: "Parked" },
            ]}
            onChange={(value) =>
              setEdgeEffect(edgeId, {
                mode: "set_flag",
                flag: value as EtherFlag,
                enabled: effect.enabled,
              })
            }
          />
        </label>
      ) : null}
      {effect?.mode === "enqueue_task" || effect?.mode === "inject_prompt" ? (
        <div className="inspector-detail" style={{ marginTop: 8 }}>
          Content is built from the firing event — no template on the wire.
        </div>
      ) : null}
    </div>
  );
}

function HoldSection({
  edgeId,
  edge,
}: {
  readonly edgeId: string;
  readonly edge: CanvasEdge;
}) {
  const criteria = edge.ether?.stops ?? edge.ether?.criteria;
  const mode =
    criteria?.mode === "proof"
      ? "proof"
      : criteria?.mode === "approval"
        ? "approval"
        : "none";
  const step =
    criteria && (criteria.mode === "proof" || criteria.mode === "approval")
      ? criteria.step
      : "gate";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Hold (gate)</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        Optional deliberate gate. Work stoppage is automatic — not a toggle.
      </div>
      <label className="inspector-editor">
        <span>Kind</span>
        <Select
          dense
          aria-label="Hold on this link"
          value={mode}
          options={[
            { value: "none", label: "None" },
            { value: "proof", label: "Proof step" },
            { value: "approval", label: "Human approval" },
          ]}
          onChange={(value) => {
            if (value === "none") {
              setEdgeCriteria(edgeId, undefined);
              return;
            }
            const next: EdgeCriteria =
              value === "proof"
                ? { mode: "proof", step: step || "gate" }
                : { mode: "approval", step: step || "gate" };
            setEdgeCriteria(edgeId, next);
          }}
        />
      </label>
      {mode !== "none" ? (
        <label className="inspector-editor">
          <span>Step name</span>
          <input
            aria-label="Gate step name"
            value={step}
            onChange={(event) => {
              const nextStep = event.target.value.trim() || "gate";
              setEdgeCriteria(
                edgeId,
                mode === "proof"
                  ? { mode: "proof", step: nextStep }
                  : { mode: "approval", step: nextStep },
              );
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

function TriggerReadout({
  edge,
  fromNode,
  toNode,
}: {
  readonly edge: CanvasEdge;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const from = fromNode ? nodeTitle(fromNode) : "This end";
  const to = toNode ? nodeTitle(toNode) : "the scheduler";
  const schedulerId =
    toNode?.ether?.entity?.kind === "relay" ||
    toNode?.ether?.entity?.kind === "cron" ||
    toNode?.ether?.entity?.kind === "timer" ||
    toNode?.ether?.entity?.kind === "watcher"
      ? toNode.id
      : fromNode?.ether?.entity?.kind === "relay" ||
          fromNode?.ether?.entity?.kind === "cron"
        ? fromNode.id
        : toNode?.id;

  const fireNow = async () => {
    if (!schedulerId) {
      setStatus("No scheduler on this link");
      return;
    }
    const api = window.vellum;
    const canvas = state$.canvasName.peek();
    if (!api?.schedulerFire || !canvas) {
      setStatus("Fire is unavailable");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const result = await api.schedulerFire(canvas, schedulerId);
      setStatus(result.ok ? "Fired" : result.error);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Trigger</div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        {from} can fire {to}. Pipeline is the output wires leaving the scheduler.
      </div>
      <button
        type="button"
        className="inspector-flag-toggle"
        disabled={busy}
        style={{
          color: HUE.violet,
          borderColor: withAlpha(HUE.violet, 0.5),
          background: withAlpha(HUE.violet, 0.1),
        }}
        onClick={() => void fireNow()}
      >
        {busy ? "Firing…" : "Fire now"}
      </button>
      {status ? (
        <div className="inspector-detail" style={{ marginTop: 8 }}>
          {status}
        </div>
      ) : null}
      {edge.ether?.ports?.includes("relay.trigger") ? (
        <div className="inspector-detail" style={{ marginTop: 6 }}>
          Agents with this link may call relay.trigger.
        </div>
      ) : null}
    </div>
  );
}

export function WireSheetBody({
  edge,
  fromNode,
  toNode,
  showDelete = false,
  onDelete,
}: {
  readonly edge: CanvasEdge;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
  readonly showDelete?: boolean;
  readonly onDelete?: () => void;
}) {
  const family = resolveEdgeFamily(edge, fromNode, toNode);
  if (!family) {
    return (
      <>
        <EdgePortsAttenuator edge={edge} />
        {showDelete && onDelete ? (
          <div className="inspector-actions">
            <button
              type="button"
              className="inspector-action--danger"
              onClick={onDelete}
            >
              Delete link
            </button>
          </div>
        ) : null}
      </>
    );
  }

  const sections = sheetSectionsFor({
    family,
    fromKind: fromNode?.ether?.entity?.kind,
    toKind: toNode?.ether?.entity?.kind,
  });
  const sentence = edgeSheetSentence(edge, fromNode, toNode);

  return (
    <>
      {sentence ? (
        <div className="inspector-detail" style={{ marginBottom: 10 }}>
          {sentence}
        </div>
      ) : null}
      {sections.map((section) => {
        switch (section._tag) {
          case "ports":
            return <EdgePortsAttenuator key="ports" edge={edge} />;
          case "wake":
            return sections.some((s) => s._tag === "ports") ? null : (
              <EdgeBoardNotifyToggle key="wake" edge={edge} />
            );
          case "when":
            return (
              <WhenSection
                key="when"
                edgeId={edge.id}
                section={section}
                edge={edge}
              />
            );
          case "does":
            return (
              <DoesSection
                key="does"
                edgeId={edge.id}
                section={section}
                edge={edge}
                toNode={toNode}
              />
            );
          case "hold":
            return <HoldSection key="hold" edgeId={edge.id} edge={edge} />;
          case "trigger_readout":
            return (
              <TriggerReadout
                key="trigger"
                edge={edge}
                fromNode={fromNode}
                toNode={toNode}
              />
            );
          case "delete":
            return showDelete && onDelete ? (
              <div key="delete" className="inspector-actions">
                <button
                  type="button"
                  className="inspector-action--danger"
                  onClick={onDelete}
                >
                  Delete link
                </button>
              </div>
            ) : null;
          default: {
            const _exhaustive: never = section;
            return _exhaustive;
          }
        }
      })}
    </>
  );
}
