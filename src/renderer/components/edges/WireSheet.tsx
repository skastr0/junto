/**
 * Dynamic edge config sheet — sections from family + node contracts.
 */
import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type {
  CanvasEdge,
  CanvasNode,
  EdgeEffect,
  EtherFlag,
  WatchWhen,
  WatchWhenAtom,
} from "@shared/canvas";
import {
  defaultEffectBoardCreateTopic,
  defaultEffectTasksCreate,
  EFFECT_BOARD_CREATE_TOPIC_FIELDS,
  EFFECT_BOARD_POST_FIELDS,
  EFFECT_TASKS_CREATE_FIELDS,
  getEffectFormValue,
  setEffectFormValue,
  type EffectFormField,
} from "@shared/node-insert";
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
  collectEffectEdgesFrom,
  isSchedulerNode,
  schedulerSourceLabel,
  type EffectEdgeBinding,
} from "@shared/scheduler-effects";
import {
  EdgeBoardNotifyToggle,
  EdgePortsAttenuator,
} from "../InspectorFields";
import { Input, Select } from "../ui";
import {
  setAgentRelayMode,
  setEdgeEffect,
  setEdgeWhen,
} from "../../lib/edge-mutations";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { HUE, withAlpha } from "../../lib/theme";

/** Plain consequence line for one outbound does edge (gold: "adds a task on Review"). */
const describeEffectBinding = (binding: EffectEdgeBinding): string => {
  const target = nodeTitle(binding.target);
  switch (binding.effect.mode) {
    case "enqueue_task": {
      const data = binding.effect.data as { brief?: string };
      const brief = (data.brief ?? "").trim();
      return brief.length > 0
        ? `adds “${brief}” on ${target}`
        : `adds inventory on ${target}`;
    }
    case "board_create_topic": {
      const data = binding.effect.data as { title?: string };
      const title = (data.title ?? "").trim();
      return title.length > 0
        ? `opens topic “${title}” on ${target}`
        : `opens a topic on ${target}`;
    }
    case "board_post":
      return `posts to ${target}`;
    case "inject_prompt":
      return `sends a prompt to ${target}`;
    case "set_flag":
      return `sets ${binding.effect.flag} on ${target}`;
    default:
      return `acts on ${target}`;
  }
};

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

/** Stable id so page ready vs failed (both completes) stay independent chips. */
const atomKey = (atom: WatchWhenAtom): string =>
  atom.word === "flagged"
    ? `flagged:${atom.flag}`
    : `completes:${atom.equals ?? ""}`;

const eventToAtom = (event: ContractEvent): WatchWhenAtom => {
  if (event.word === "flagged" && event.flag) {
    return { word: "flagged", flag: event.flag };
  }
  return {
    word: "completes",
    ...(event.equals !== undefined ? { equals: event.equals } : {}),
  };
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

const effectFormFields = (
  mode: string | undefined,
): ReadonlyArray<EffectFormField> => {
  if (mode === "enqueue_task") return EFFECT_TASKS_CREATE_FIELDS;
  if (mode === "board_create_topic") return EFFECT_BOARD_CREATE_TOPIC_FIELDS;
  if (mode === "board_post") return EFFECT_BOARD_POST_FIELDS;
  return [];
};

function DoesSection({
  edgeId,
  section,
  edge,
  fromNode,
  toNode,
}: {
  readonly edgeId: string;
  readonly section: Extract<SheetSection, { readonly _tag: "does" }>;
  readonly edge: CanvasEdge;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const effect = edge.ether?.does;
  const mode = effect?.mode ?? "none";
  const options = [
    { value: "none", label: "Do nothing" },
    ...section.inputs.map((input) => ({
      value: input.mode,
      label: input.label,
    })),
  ];
  const fields = effectFormFields(effect?.mode);
  const label = fromNode ? schedulerSourceLabel(fromNode) : "scheduler";

  const patchPayload = (next: EdgeEffect) => {
    setEdgeEffect(edgeId, next);
  };

  const dataRecord =
    effect &&
    (effect.mode === "enqueue_task" ||
      effect.mode === "board_create_topic" ||
      effect.mode === "board_post")
      ? (effect.data as Record<string, unknown>)
      : {};

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
                data: defaultEffectTasksCreate(label),
              });
              return;
            }
            if (value === "board_create_topic") {
              setEdgeEffect(edgeId, {
                mode: "board_create_topic",
                data: defaultEffectBoardCreateTopic(label),
              });
              return;
            }
            if (value === "board_post") {
              setEdgeEffect(edgeId, {
                mode: "board_post",
                data: { topicId: "", text: "" },
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
      {effect &&
      (effect.mode === "enqueue_task" ||
        effect.mode === "board_create_topic" ||
        effect.mode === "board_post")
        ? fields.map((field) => {
            const value = getEffectFormValue(dataRecord, field.path);
            const id = `does-${edgeId}-${field.path}`;
            const onRaw = (raw: string) => {
              const nextData = setEffectFormValue(
                { ...dataRecord },
                field.path,
                raw,
                field.kind,
              );
              if (effect.mode === "enqueue_task") {
                patchPayload({
                  mode: "enqueue_task",
                  data: nextData as typeof effect.data,
                });
              } else if (effect.mode === "board_create_topic") {
                patchPayload({
                  mode: "board_create_topic",
                  data: nextData as typeof effect.data,
                });
              } else {
                patchPayload({
                  mode: "board_post",
                  data: nextData as typeof effect.data,
                });
              }
            };
            if (field.kind === "boolean") {
              return (
                <label key={field.path} className="inspector-editor">
                  <span>{field.label}</span>
                  <input
                    id={id}
                    type="checkbox"
                    aria-label={field.label}
                    checked={value === "true"}
                    onChange={(event) =>
                      onRaw(event.target.checked ? "true" : "false")
                    }
                  />
                </label>
              );
            }
            if (field.kind === "textarea") {
              return (
                <label key={field.path} className="inspector-editor">
                  <span>
                    {field.label}
                    {field.required ? "" : " (optional)"}
                  </span>
                  <textarea
                    id={id}
                    aria-label={field.label}
                    rows={3}
                    value={value}
                    onChange={(event) => onRaw(event.target.value)}
                  />
                </label>
              );
            }
            return (
              <label key={field.path} className="inspector-editor">
                <span>
                  {field.label}
                  {field.required ? "" : " (optional)"}
                </span>
                <Input
                  id={id}
                  aria-label={field.label}
                  type={field.kind === "number" ? "number" : "text"}
                  min={field.kind === "number" ? 1 : undefined}
                  value={value}
                  onChange={(event) => onRaw(event.target.value)}
                />
              </label>
            );
          })
        : null}
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
    </div>
  );
}

function TriggerReadout({
  fromNode,
  toNode,
}: {
  readonly edge: CanvasEdge;
  readonly fromNode: CanvasNode | undefined;
  readonly toNode: CanvasNode | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const doc = use$(state$.doc);
  // Fire the scheduler end of the trigger wire (prefer target; else source).
  // Never fires the actor side; never cascades to other schedulers.
  const scheduler = useMemo(() => {
    if (isSchedulerNode(toNode)) return toNode;
    if (isSchedulerNode(fromNode)) return fromNode;
    return undefined;
  }, [fromNode, toNode]);
  const from = fromNode ? nodeTitle(fromNode) : "This end";
  const schedulerName = scheduler ? nodeTitle(scheduler) : "the scheduler";
  // Outbound does wires of this scheduler only — not other nodes' effects.
  const effects = useMemo(
    () =>
      scheduler
        ? collectEffectEdgesFrom(doc, scheduler.id)
        : ([] as ReadonlyArray<EffectEdgeBinding>),
    [doc, scheduler],
  );
  const firingLine =
    effects.length === 0
      ? `Firing ${schedulerName} does nothing yet — draw an effect wire out.`
      : `Firing ${schedulerName}: ${effects.map(describeEffectBinding).join("; ")}.`;

  const fireNow = async () => {
    if (!scheduler) {
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
      const result = await api.schedulerFire(canvas, scheduler.id);
      setStatus(result.ok ? result.message : result.error);
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
        {from} can fire {schedulerName}.
      </div>
      <div className="inspector-detail" style={{ marginBottom: 8 }}>
        {firingLine}
      </div>
      <button
        type="button"
        className="inspector-flag-toggle"
        disabled={busy || !scheduler}
        style={{
          color: HUE.violet,
          borderColor: withAlpha(HUE.violet, 0.5),
          background: withAlpha(HUE.violet, 0.1),
        }}
        onClick={() => void fireNow()}
      >
        {busy ? "Firing…" : `Fire ${schedulerName} now`}
      </button>
      {status ? (
        <div className="inspector-detail" style={{ marginTop: 8 }}>
          {status}
        </div>
      ) : null}
    </div>
  );
}

/** Gold: agent→relay is fire XOR watch — one authoring choice. */
function AgentRelayModeSection({
  edgeId,
  edge,
}: {
  readonly edgeId: string;
  readonly edge: CanvasEdge;
}) {
  const mode = edge.ether?.slot === "input" ? "watch" : "fire";
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">This link</div>
      <label className="inspector-editor">
        <span>Role</span>
        <Select
          dense
          aria-label="Agent to relay role"
          value={mode}
          options={[
            { value: "fire", label: "Agent may fire the relay" },
            { value: "watch", label: "Relay watches the agent" },
          ]}
          onChange={(value) =>
            setAgentRelayMode(edgeId, value === "watch" ? "watch" : "fire")
          }
        />
      </label>
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
  const fromKind = fromNode?.ether?.entity?.kind;
  const toKind = toNode?.ether?.entity?.kind;
  const agentRelay =
    fromKind === "agent" && toKind === "relay";

  if (!family && !agentRelay) {
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

  const effectiveFamily =
    family ??
    (agentRelay
      ? edge.ether?.slot === "input"
        ? ("watch" as const)
        : ("trigger" as const)
      : undefined);

  const sections = effectiveFamily
    ? sheetSectionsFor({
        family: effectiveFamily,
        fromKind,
        toKind,
      })
    : [];
  const sentence = edgeSheetSentence(edge, fromNode, toNode);

  return (
    <>
      {sentence ? (
        <div className="inspector-detail" style={{ marginBottom: 10 }}>
          {sentence}
        </div>
      ) : null}
      {agentRelay ? (
        <AgentRelayModeSection edgeId={edge.id} edge={edge} />
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
                fromNode={fromNode}
                toNode={toNode}
              />
            );
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
