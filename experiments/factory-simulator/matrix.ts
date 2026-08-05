import { HashSet, Result } from "effect";
import { commandCapabilities } from "../../src/cli/core/discovery";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../src/shared/canvas";
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
  type WellKnownKind,
} from "../../src/shared/physics";

export type MatrixEdgeMode =
  | "absent"
  | "unmasked"
  | "matching-mask"
  | "empty-mask"
  | "wrong-mask";

export type MatrixDirection = "forward" | "reverse";

export const MATRIX_DIRECTIONS: ReadonlyArray<MatrixDirection> = [
  "forward",
  "reverse",
];

export const MATRIX_EDGE_MODES: ReadonlyArray<MatrixEdgeMode> = [
  "absent",
  "unmasked",
  "matching-mask",
  "empty-mask",
  "wrong-mask",
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
  | "browser-plane";

const SEAT_LOCAL_COMMANDS = new Set([
  "ping",
  "doctor",
  "capabilities",
  "onboard",
  "preamble",
]);

const DISCOVERY_COMMANDS = new Set([
  "schema.list",
  "schema.show",
  "examples.list",
  "examples.show",
]);

export const classifyCliCommand = (commandId: string): CliCoverageLane | undefined => {
  if (isTargetWorkOp(commandId)) return "target-matrix";
  if (SEAT_LOCAL_COMMANDS.has(commandId)) return "seat-local";
  if (DISCOVERY_COMMANDS.has(commandId)) return "discovery";
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
    .filter(isTargetWorkOp);

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

const wrongPort = (port: Port): Port => {
  const candidate = commandCapabilities
    .map(({ command_id: commandId }) =>
      isTargetWorkOp(commandId) ? portForWorkOp(commandId) : undefined,
    )
    .find((value): value is Port => value !== undefined && value !== port);
  if (candidate === undefined) throw new Error(`no wrong-port fixture for ${port}`);
  return candidate;
};

const edgeFor = (
  direction: MatrixDirection,
  edgeMode: MatrixEdgeMode,
  port: Port,
): CanvasEdge | undefined => {
  if (edgeMode === "absent") return undefined;
  const [fromNode, toNode] =
    direction === "forward" ? ["source", "target"] : ["target", "source"];
  const ports =
    edgeMode === "unmasked"
      ? undefined
      : edgeMode === "matching-mask"
        ? [port]
        : edgeMode === "wrong-mask"
          ? [wrongPort(port)]
          : [];
  return {
    id: "edge",
    fromNode,
    toNode,
    ...(ports === undefined ? {} : { ether: { ports } }),
  };
};

const expectedAdmission = (
  sourceKind: WellKnownKind,
  targetKind: WellKnownKind,
  edgeMode: MatrixEdgeMode,
  port: Port,
): "allow" | "deny" => {
  if (sourceKind !== "agent" || edgeMode === "absent") return "deny";
  if (!HashSet.has(KindSpecs[targetKind].offers, port)) return "deny";
  if (KindSpecs[targetKind].role === "scheduler") {
    return edgeMode === "matching-mask" ? "allow" : "deny";
  }
  return edgeMode === "unmasked" || edgeMode === "matching-mask"
    ? "allow"
    : "deny";
};

export const generateCliAuthorizationMatrix = (): ReadonlyArray<CliMatrixCell> => {
  const cells: CliMatrixCell[] = [];

  for (const commandId of targetMatrixCommands()) {
    const port = portForWorkOp(commandId);
    for (const sourceKind of WELL_KNOWN_KINDS) {
      for (const targetKind of WELL_KNOWN_KINDS) {
        for (const direction of MATRIX_DIRECTIONS) {
          for (const edgeMode of MATRIX_EDGE_MODES) {
            const edge = edgeFor(direction, edgeMode, port);
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
              expected: expectedAdmission(sourceKind, targetKind, edgeMode, port),
              actual: Result.isSuccess(result) ? "allow" : "deny",
            });
          }
        }
      }
    }
  }
  return cells;
};
