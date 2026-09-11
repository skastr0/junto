import {
  nodeRefKey,
  parseNodeRef,
  type NodeRef,
  type NodeRefKey,
} from "@shared/node-ref";

export interface NodeRefIngressTarget {
  readonly ref: NodeRefKey;
  readonly canvasName: string;
  readonly nodeId: string;
}

export type NodeRefIngressResult =
  | {
      readonly ok: true;
      readonly target: NodeRefIngressTarget;
      readonly delivery: "emitted" | "queued";
    }
  | {
      readonly ok: false;
      readonly code: "invalid" | "unresolved" | "superseded";
      readonly message: string;
    };

export interface NodeRefIngressResolver {
  (ref: NodeRef): Promise<{ readonly key: NodeRefKey }>;
}

export interface NodeRefIngress {
  readonly accept: (uri: string) => Promise<NodeRefIngressResult>;
  readonly connect: (sink: (target: NodeRefIngressTarget) => void) => () => void;
}

export const canonicalNodeRefUri = (uri: string): NodeRefKey | undefined => {
  const parsed = parseNodeRef(uri);
  if (!parsed.ok) return undefined;
  const canonical = nodeRefKey(parsed.value);
  return canonical === uri ? canonical : undefined;
};

/** Returns the last exact node reference, matching the platform's latest-wins open semantics. */
export const latestNodeRefUri = (
  candidates: Iterable<string>,
): NodeRefKey | undefined => {
  let latest: NodeRefKey | undefined;
  for (const candidate of candidates) {
    const canonical = canonicalNodeRefUri(candidate);
    if (canonical !== undefined) latest = canonical;
  }
  return latest;
};

export const makeNodeRefIngress = (resolve: NodeRefIngressResolver): NodeRefIngress => {
  let revision = 0;
  let pending: NodeRefIngressTarget | undefined;
  let sink: ((target: NodeRefIngressTarget) => void) | undefined;

  const deliver = (target: NodeRefIngressTarget): "emitted" | "queued" => {
    if (sink === undefined) {
      pending = target;
      return "queued";
    }
    try {
      sink(target);
      return "emitted";
    } catch {
      pending = target;
      return "queued";
    }
  };

  const accept = (uri: string): Promise<NodeRefIngressResult> => {
    const acceptedRevision = ++revision;
    pending = undefined;
    const task = (async (): Promise<NodeRefIngressResult> => {
      const parsed = parseNodeRef(uri);
      if (!parsed.ok) {
        return { ok: false, code: "invalid", message: parsed.error.message };
      }
      if (nodeRefKey(parsed.value) !== uri) {
        return {
          ok: false,
          code: "invalid",
          message: "node reference must use its canonical URI encoding",
        };
      }

      let resolved: { readonly key: NodeRefKey };
      try {
        resolved = await resolve(parsed.value);
      } catch (error) {
        if (acceptedRevision !== revision) {
          return { ok: false, code: "superseded", message: "a newer node reference arrived" };
        }
        return {
          ok: false,
          code: "unresolved",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (acceptedRevision !== revision) {
        return { ok: false, code: "superseded", message: "a newer node reference arrived" };
      }

      const canonical = nodeRefKey(parsed.value);
      if (resolved.key !== canonical) {
        return {
          ok: false,
          code: "unresolved",
          message: "node-reference resolver returned a mismatched canonical key",
        };
      }
      const target: NodeRefIngressTarget = {
        ref: canonical,
        canvasName: parsed.value.canvasName,
        nodeId: parsed.value.nodeId,
      };
      return { ok: true, target, delivery: deliver(target) };
    })();
    return task;
  };

  const connect = (nextSink: (target: NodeRefIngressTarget) => void): (() => void) => {
    sink = nextSink;
    const queued = pending;
    if (queued !== undefined) {
      pending = undefined;
      try {
        nextSink(queued);
      } catch {
        pending = queued;
      }
    }
    return () => {
      if (sink === nextSink) sink = undefined;
    };
  };

  return {
    accept,
    connect,
  };
};
