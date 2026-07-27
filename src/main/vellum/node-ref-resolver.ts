import { Effect } from "effect";
import type { CanvasNode } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary } from "@shared/ipc";
import { nodeRefKey, type NodeRef, type NodeRefKey } from "@shared/node-ref";
import type { CanvasError } from "./canvases";

export interface CanvasNodeReader {
  readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
  readonly read: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
}

export type NodeRefResolutionError =
  | {
      readonly _tag: "InvalidNodeRef";
      readonly ref: NodeRef;
      readonly message: string;
    }
  | {
      readonly _tag: "CanvasNotFound";
      readonly ref: NodeRef;
    }
  | {
      readonly _tag: "CanvasReadError";
      readonly ref: NodeRef;
      readonly message: string;
    }
  | {
      readonly _tag: "NodeNotFound";
      readonly ref: NodeRef;
    }
  | {
      readonly _tag: "DuplicateNodeId";
      readonly ref: NodeRef;
      readonly count: number;
    }
  | {
      readonly _tag: "NodeKindMismatch";
      readonly ref: NodeRef;
      readonly expected: string;
      readonly actual?: string;
    };

export interface ResolvedNodeRef {
  readonly ref: NodeRef;
  readonly key: NodeRefKey;
  readonly canvasName: string;
  readonly node: CanvasNode;
}

export interface ResolveNodeRefOptions {
  readonly expectedEntityKind?: string;
}

export const resolveNodeRef = (
  canvases: CanvasNodeReader,
  ref: NodeRef,
  options: ResolveNodeRefOptions = {},
): Effect.Effect<ResolvedNodeRef, NodeRefResolutionError> =>
  Effect.gen(function* () {
    let key: NodeRefKey;
    try {
      key = nodeRefKey(ref);
    } catch (error) {
      return yield* Effect.fail({
        _tag: "InvalidNodeRef" as const,
        ref,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const summaries = yield* canvases.list.pipe(
      Effect.mapError(
        (error): NodeRefResolutionError => ({
          _tag: "CanvasReadError",
          ref,
          message: error.message,
        }),
      ),
    );
    if (!summaries.some((summary) => summary.name === ref.canvasName)) {
      return yield* Effect.fail({ _tag: "CanvasNotFound" as const, ref });
    }

    const canvas = yield* canvases.read(ref.canvasName).pipe(
      Effect.mapError(
        (error): NodeRefResolutionError => ({
          _tag: "CanvasReadError",
          ref,
          message: error.message,
        }),
      ),
    );
    const matches = canvas.doc.nodes.filter((node) => node.id === ref.nodeId);
    if (matches.length === 0) {
      return yield* Effect.fail({ _tag: "NodeNotFound" as const, ref });
    }
    if (matches.length !== 1) {
      return yield* Effect.fail({
        _tag: "DuplicateNodeId" as const,
        ref,
        count: matches.length,
      });
    }

    const node = matches[0];
    if (node === undefined) {
      return yield* Effect.fail({ _tag: "NodeNotFound" as const, ref });
    }
    const expected = options.expectedEntityKind;
    const actual = node.ether?.entity?.kind;
    if (expected !== undefined && actual !== expected) {
      return yield* Effect.fail({
        _tag: "NodeKindMismatch" as const,
        ref,
        expected,
        ...(actual === undefined ? {} : { actual }),
      });
    }

    return {
      ref,
      key,
      canvasName: ref.canvasName,
      node,
    };
  });
