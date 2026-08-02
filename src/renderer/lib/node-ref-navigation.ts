import type { CanvasReadResult, NodeRefOpenedEvent } from "@shared/ipc";
import { nodeRefKey, parseNodeRef } from "@shared/node-ref";

export interface NavigationClock {
  readonly begin: () => number;
  readonly isCurrent: (request: number) => boolean;
}

export const makeNavigationClock = (): NavigationClock => {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (request) => request === current,
  };
};

export type NodeRefNavigationErrorCode =
  | "event"
  | "read"
  | "canvas"
  | "missing"
  | "duplicate"
  | "apply";

export class NodeRefNavigationError extends Error {
  readonly name = "NodeRefNavigationError";

  constructor(
    readonly code: NodeRefNavigationErrorCode,
    message: string,
    readonly causeValue?: unknown,
  ) {
    super(message);
  }
}

export interface NodeRefNavigationDependencies {
  readonly clock: NavigationClock;
  readonly readCanvas: (name: string) => Promise<CanvasReadResult>;
  /** Re-check process-local authoring admission immediately before apply. */
  readonly assertCanApply?: () => void;
  readonly apply: (event: NodeRefOpenedEvent, result: CanvasReadResult) => void;
  readonly onFailure?: (error: NodeRefNavigationError) => void;
}

export interface NodeRefNavigationCoordinator {
  readonly navigate: (event: NodeRefOpenedEvent) => Promise<void>;
  readonly hasReceived: () => boolean;
}

const decodeEvent = (event: NodeRefOpenedEvent): NodeRefOpenedEvent | undefined => {
  const value: unknown = event;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).sort().join(",") !== "canvasName,nodeId,ref") return undefined;
  if (!("ref" in value) || typeof value.ref !== "string") return undefined;
  if (!("canvasName" in value) || typeof value.canvasName !== "string") return undefined;
  if (!("nodeId" in value) || typeof value.nodeId !== "string") return undefined;

  const parsed = parseNodeRef(value.ref);
  if (!parsed.ok || nodeRefKey(parsed.success) !== value.ref) return undefined;
  if (parsed.success.canvasName !== value.canvasName || parsed.success.nodeId !== value.nodeId) {
    return undefined;
  }
  return {
    ref: value.ref,
    canvasName: value.canvasName,
    nodeId: value.nodeId,
  };
};

export const makeNodeRefNavigationCoordinator = (
  dependencies: NodeRefNavigationDependencies,
): NodeRefNavigationCoordinator => {
  let received = false;

  const report = (error: NodeRefNavigationError): NodeRefNavigationError => {
    dependencies.onFailure?.(error);
    return error;
  };

  const navigate = async (untrustedEvent: NodeRefOpenedEvent): Promise<void> => {
    received = true;
    // Beginning before validation means a newer malformed delivery still
    // supersedes an older slow read. The malformed latest delivery is retained
    // by preload because this promise rejects.
    const request = dependencies.clock.begin();
    const event = decodeEvent(untrustedEvent);
    if (event === undefined) {
      throw report(new NodeRefNavigationError("event", "This node reference is invalid."));
    }

    let result: CanvasReadResult;
    try {
      result = await dependencies.readCanvas(event.canvasName);
    } catch (cause) {
      if (!dependencies.clock.isCurrent(request)) return;
      throw report(
        new NodeRefNavigationError(
          "read",
          "The referenced canvas could not be read.",
          cause,
        ),
      );
    }

    // Obsolete deliveries resolve without applying so preload can acknowledge
    // and discard them instead of replaying an older locator over the winner.
    if (!dependencies.clock.isCurrent(request)) return;
    if (result.name !== event.canvasName) {
      throw report(
        new NodeRefNavigationError("canvas", "The referenced canvas changed during navigation."),
      );
    }

    const matches = result.doc.nodes.filter((node) => node.id === event.nodeId);
    if (matches.length === 0) {
      throw report(new NodeRefNavigationError("missing", "The referenced node no longer exists."));
    }
    if (matches.length !== 1) {
      throw report(
        new NodeRefNavigationError("duplicate", "The referenced node identity is ambiguous."),
      );
    }
    if (!dependencies.clock.isCurrent(request)) return;

    try {
      dependencies.assertCanApply?.();
      dependencies.apply(event, result);
    } catch (cause) {
      throw report(
        new NodeRefNavigationError(
          "apply",
          "The referenced node could not be focused.",
          cause,
        ),
      );
    }
  };

  return {
    navigate,
    hasReceived: () => received,
  };
};
