/**
 * Dynamic edge config sheet — sections from family + node contracts.
 * Sheet law: only settings physics cannot derive. See wire-grammar artifact.
 */
import type { CanvasEdge, CanvasNode, EtherFlag } from "@shared/canvas";
import {
  familyFromSlot,
  resolveSpec,
  roleOf,
  sheetSectionsFor,
  sheetTitleFor,
  wirePresentation,
  wireRolePair,
  type SheetSection,
  type WireFamily,
} from "@shared/physics";
import {
  EdgeBoardNotifyToggle,
  EdgePortsAttenuator,
} from "../InspectorFields";
import { Select } from "../ui";
import { setEdgeEffect, setEdgeWhen } from "../../lib/edge-mutations";
import { nodeTitle } from "../../lib/presentation";

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

function WhenSection({
  edgeId,
  section,
  edge,
}: {
  readonly edgeId: string;
  readonly section: Extract<SheetSection, { readonly _tag: "when" }>;
  readonly edge: CanvasEdge;
}) {
  const when = edge.ether?.when;
  const value =
    when?.word === "flagged"
      ? `flagged:${when.flag}`
      : when?.word === "completes"
        ? section.events.find((e) => e.word === "completes")?.id ?? "completes"
        : "none";

  const options = [
    { value: "none", label: "Not set" },
    ...section.events.map((event) => ({
      value:
        event.word === "flagged" && event.flag
          ? `flagged:${event.flag}`
          : event.id,
      label: event.label,
    })),
  ];

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Fires when</div>
      <label className="inspector-editor">
        <span>Condition</span>
        <Select
          dense
          aria-label="Condition that fires this relay"
          value={value}
          options={options}
          onChange={(next) => {
            if (next === "none") {
              setEdgeWhen(edgeId, undefined);
              return;
            }
            if (next.startsWith("flagged:")) {
              const flag = next.replace("flagged:", "") as EtherFlag;
              setEdgeWhen(edgeId, { word: "flagged", flag });
              return;
            }
            const event = section.events.find((e) => e.id === next);
            if (event?.word === "flagged" && event.flag) {
              setEdgeWhen(edgeId, { word: "flagged", flag: event.flag });
              return;
            }
            setEdgeWhen(edgeId, { word: "completes" });
          }}
        />
      </label>
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
      {effect?.mode === "enqueue_task" ? (
        <div className="inspector-detail" style={{ marginTop: 8 }}>
          Task content is built from the firing event — no template on the wire.
        </div>
      ) : null}
    </div>
  );
}

function TriggerReadout({
  fromNode,
  toNode,
}: {
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const from = fromNode ? nodeTitle(fromNode) : "This end";
  const to = toNode ? nodeTitle(toNode) : "the scheduler";
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">Trigger</div>
      <div className="inspector-detail">
        {from} can fire {to}. No settings — the pipeline is the output wires
        leaving the scheduler.
      </div>
    </div>
  );
}

/**
 * Body of the edge sheet: only sections the pair's family + contracts admit.
 * Caller owns header + delete action.
 */
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
            // EdgePortsAttenuator already mounts the board toggle when ports
            // empty; when ports exist the attenuator also mounts it. Render
            // standalone only if ports section is absent (never for access).
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
          case "trigger_readout":
            return (
              <TriggerReadout
                key="trigger"
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
