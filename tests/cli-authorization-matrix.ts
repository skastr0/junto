import { HashSet, Result } from "effect";
import { commandCapabilities } from "../src/cli/core/discovery";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import {
  KindSpecs,
  WELL_KNOWN_KINDS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  isTargetWorkOp,
  portForWorkOp,
  type Port,
  type TargetWorkOpName,
  type Verb,
  type WellKnownKind,
} from "../src/shared/physics";

/**
 * How the edge in a cell states its relationship. A verb is the whole authored
 * fact, so the axis is which verb the operator drew, not how a port mask was
 * attenuated.
 */
export type MatrixEdgeMode =
  | "absent"
  | "wide-verb"
  | "narrow-verb"
  | "foreign-verb";

export type MatrixDirection = "forward" | "reverse";

export const MATRIX_DIRECTIONS: ReadonlyArray<MatrixDirection> = [
  "forward",
  "reverse",
];

export const MATRIX_EDGE_MODES: ReadonlyArray<MatrixEdgeMode> = [
  "absent",
  "wide-verb",
  "narrow-verb",
  "foreign-verb",
];

export interface CliMatrixCell {
  readonly commandId: TargetWorkOpName;
  readonly sourceKind: WellKnownKind;
  readonly targetKind: WellKnownKind;
  readonly direction: MatrixDirection;
  readonly edgeMode: MatrixEdgeMode;
  readonly expected: "allow" | "deny";
  readonly actual: "allow" | "deny";
}

export type CliCoverageLane =
  | "target-matrix"
  | "seat-local"
  | "discovery"
  | "overseer-plane"
  | "browser-plane";

const SEAT_LOCAL_COMMANDS = new Set([
  "ping",
  "doctor",
  "capabilities",
  "onboard",
  "preamble",
  "msg.sent",
]);

const DISCOVERY_COMMANDS = new Set([
  "schema.list",
  "schema.show",
  "examples.list",
  "examples.show",
  "overseer.skill",
  "overseer.schema",
  "overseer.examples",
  "overseer.capabilities",
]);

export const classifyCliCommand = (commandId: string): CliCoverageLane | undefined => {
  if (isTargetWorkOp(commandId as TargetWorkOpName)) return "target-matrix";
  // CLI projections of pad.read (digest/svg/look-here/get/tagged) share that grant.
  if (commandId.startsWith("pad.")) return "target-matrix";
  if (SEAT_LOCAL_COMMANDS.has(commandId)) return "seat-local";
  if (DISCOVERY_COMMANDS.has(commandId)) return "discovery";
  // Human delegation, not edge capability, admits this separate plane.
  if (commandId.startsWith("overseer.")) return "overseer-plane";
  if (commandId.startsWith("browser.")) return "browser-plane";
  return undefined;
};

export const cliCoverageManifest = () =>
  commandCapabilities.map(({ command_id: commandId }) => ({
    commandId,
    lane: classifyCliCommand(commandId),
  }));

export const targetMatrixCommands = (): ReadonlyArray<TargetWorkOpName> =>
  commandCapabilities
    .map(({ command_id: commandId }) => commandId)
    .filter((commandId): commandId is TargetWorkOpName =>
      isTargetWorkOp(commandId as TargetWorkOpName));

export const expectedCliAuthorizationCellCount = (): number =>
  targetMatrixCommands().length *
  WELL_KNOWN_KINDS.length *
  WELL_KNOWN_KINDS.length *
  MATRIX_DIRECTIONS.length *
  MATRIX_EDGE_MODES.length;

const textNode = (id: string, kind: WellKnownKind, x: number): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y: 0,
  width: 160,
  height: 80,
  ether: { entity: { kind } },
});

/**
 * The oracle, restated from the frozen verb grammar rather than read back out
 * of it: for each sink an agent can reach, the wide verb and the narrow one,
 * and the ports each opens. `narrow` repeats `wide` where the pair holds only
 * one verb.
 */
const AGENT_SINK_GRANTS = {
  task: {
    wide: { verb: "contributes", ports: ["tasks.create", "tasks.update", "tasks.list", "tasks.claim", "msg.list", "msg.send"] },
    narrow: { verb: "manages", ports: ["tasks.create", "tasks.update", "tasks.list", "msg.list", "msg.send"] },
  },
  requests: {
    wide: { verb: "escalates", ports: ["request.escalate", "msg.list", "msg.send"] },
    narrow: { verb: "escalates", ports: ["request.escalate", "msg.list", "msg.send"] },
  },
  artifacts: {
    wide: { verb: "publishes", ports: ["artifact.publish"] },
    narrow: { verb: "publishes", ports: ["artifact.publish"] },
  },
  board: {
    wide: { verb: "participates", ports: ["board.list", "board.create_topic", "board.post", "board.mark_read"] },
    narrow: { verb: "messages", ports: ["board.list", "board.post", "board.mark_read"] },
  },
  pad: {
    wide: { verb: "edits", ports: ["pad.read", "pad.patch"] },
    narrow: { verb: "reads", ports: ["pad.read"] },
  },
  page: {
    wide: { verb: "navigates", ports: ["browser.automate"] },
    narrow: { verb: "navigates", ports: ["browser.automate"] },
  },
  agent: {
    wide: { verb: "messages", ports: ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"] },
    narrow: { verb: "messages", ports: ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"] },
  },
  relay: {
    wide: { verb: "fires", ports: ["relay.trigger"] },
    narrow: { verb: "fires", ports: ["relay.trigger"] },
  },
} as const satisfies {
  readonly [K in string]: {
    readonly wide: { readonly verb: Verb; readonly ports: ReadonlyArray<Port> };
    readonly narrow: { readonly verb: Verb; readonly ports: ReadonlyArray<Port> };
  };
};

type GrantedTarget = keyof typeof AGENT_SINK_GRANTS;

const isGrantedTarget = (kind: string): kind is GrantedTarget =>
  Object.hasOwn(AGENT_SINK_GRANTS, kind);

/** A verb no agent-to-anything pair holds, so it can never compile a grant. */
const FOREIGN_VERB: Verb = "chains";

const verbFor = (
  targetKind: WellKnownKind,
  edgeMode: MatrixEdgeMode,
): Verb | undefined => {
  if (edgeMode === "absent") return undefined;
  if (edgeMode === "foreign-verb") return FOREIGN_VERB;
  if (!isGrantedTarget(targetKind)) return FOREIGN_VERB;
  const row = AGENT_SINK_GRANTS[targetKind];
  return edgeMode === "wide-verb" ? row.wide.verb : row.narrow.verb;
};

const edgeFor = (
  direction: MatrixDirection,
  edgeMode: MatrixEdgeMode,
  targetKind: WellKnownKind,
): CanvasEdge | undefined => {
  const verb = verbFor(targetKind, edgeMode);
  if (verb === undefined) return undefined;
  const [fromNode, toNode] =
    direction === "forward" ? ["source", "target"] : ["target", "source"];
  return { id: "edge", fromNode, toNode, ether: { verb } };
};

const expectedAdmission = (
  sourceKind: WellKnownKind,
  targetKind: WellKnownKind,
  direction: MatrixDirection,
  edgeMode: MatrixEdgeMode,
  port: Port,
): "allow" | "deny" => {
  if (sourceKind !== "agent" || edgeMode === "absent") return "deny";
  if (!HashSet.has(KindSpecs[targetKind].offers, port)) return "deny";
  if (!isGrantedTarget(targetKind) || edgeMode === "foreign-verb") return "deny";
  // A verb is stored in its own order: the agent end is the source. Drawing the
  // cell in reverse stores the relationship the other way round, and only the
  // agent pair — whose one verb is symmetric — still holds it there.
  if (direction === "reverse" && targetKind !== "agent") return "deny";
  const row = AGENT_SINK_GRANTS[targetKind];
  const granted = edgeMode === "wide-verb" ? row.wide.ports : row.narrow.ports;
  return (granted as ReadonlyArray<Port>).includes(port) ? "allow" : "deny";
};

export const generateCliAuthorizationMatrix = (): ReadonlyArray<CliMatrixCell> => {
  const cells: CliMatrixCell[] = [];

  for (const commandId of targetMatrixCommands()) {
    const port = portForWorkOp(commandId);
    for (const sourceKind of WELL_KNOWN_KINDS) {
      for (const targetKind of WELL_KNOWN_KINDS) {
        for (const direction of MATRIX_DIRECTIONS) {
          for (const edgeMode of MATRIX_EDGE_MODES) {
            const edge = edgeFor(direction, edgeMode, targetKind);
            const doc: CanvasDoc = {
              nodes: [
                textNode("source", sourceKind, 0),
                textNode("target", targetKind, 240),
              ],
              edges: edge === undefined ? [] : [edge],
            };
            const result = admitPure(
              canvasDocToCapabilityView(doc),
              asNodeId("source"),
              asNodeId("target"),
              port,
            );
            cells.push({
              commandId,
              sourceKind,
              targetKind,
              direction,
              edgeMode,
              expected: expectedAdmission(
                sourceKind,
                targetKind,
                direction,
                edgeMode,
                port,
              ),
              actual: Result.isSuccess(result) ? "allow" : "deny",
            });
          }
        }
      }
    }
  }
  return cells;
};
