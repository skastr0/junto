import { Effect } from "effect";
import { asNodeId, type Canvas, type CanvasName, type Node } from "@shared/model";
import { nodeRefKey, type NodeRef, type NodeRefKey } from "@shared/node-ref";
import type { ModelError } from "./model/records";

export interface ModelNodeReader {
  readonly listCanvases: () => Effect.Effect<ReadonlyArray<CanvasName>, ModelError>;
  readonly canvas: (name: string) => Effect.Effect<Canvas, ModelError>;
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
      readonly _tag: "NodeKindMismatch";
      readonly ref: NodeRef;
      readonly expected: string;
      readonly actual?: string;
    };

export interface ResolvedNodeRef {
  readonly ref: NodeRef;
  readonly key: NodeRefKey;
  readonly canvasName: string;
  readonly node: Node;
}

export interface ResolveNodeRefOptions {
  readonly expectedEntityKind?: string;
}

export const resolveNodeRef = (
  canvases: ModelNodeReader,
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

    const summaries = yield* canvases.listCanvases().pipe(
      Effect.mapError(
        (error): NodeRefResolutionError => ({
          _tag: "CanvasReadError",
          ref,
          message: error.message,
        }),
      ),
    );
    if (!summaries.some((name) => name === ref.canvasName)) {
      return yield* Effect.fail({ _tag: "CanvasNotFound" as const, ref });
    }

    const canvas = yield* canvases.canvas(ref.canvasName).pipe(
      Effect.mapError(
        (error): NodeRefResolutionError => ({
          _tag: "CanvasReadError",
          ref,
          message: error.message,
        }),
      ),
    );
    const node = canvas.nodes.get(asNodeId(ref.nodeId));
    if (node === undefined) return yield* Effect.fail({ _tag: "NodeNotFound" as const, ref });
    const expected = options.expectedEntityKind;
    const actual = node.kind;
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
