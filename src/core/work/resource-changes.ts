// Every applied write to a canvas's tasks or artifacts, by any writer (a seat
// over the work socket, the operator over IPC), said once here by the store
// port that submitted it. ipc.ts turns each into `<domain>-changed` for the
// windows, so a pane reads again whoever wrote.
//
// A thread is its own notice: a comment on a file changes no file, so it says
// only that the threads of its kind moved (F7).

import type { ArtifactOp } from "@shared/artifact";
import type { ArtifactFact } from "@shared/artifact-domain";
import type { ResourceCommand } from "@shared/resource-command";
import type { ResourceIpcDomain, ThreadResourceSubject } from "@shared/resource-ipc";

/**
 * The artifact write behind a change, when the writer knows it: the command as
 * it was ruled. A replicated row arrives without one, and then a reader knows
 * the canvas's artifacts moved but not which or how.
 */
export type ArtifactChange = { readonly command: ResourceCommand<ArtifactOp> };

/**
 * `nodeIds` names the nodes the write touched, so a reader re-reads those and
 * not the canvas. Absent, every node of the domain on the canvas may have
 * moved: a replicated row, a seat release, an automation's batch.
 */
export type ResourceChangeListener = (
  domain: ResourceIpcDomain,
  canvasName: string,
  artifact?: ArtifactChange,
  nodeIds?: ReadonlyArray<string>,
) => void;

const listeners = new Set<ResourceChangeListener>();

export const noteResourceChanged = (
  domain: ResourceIpcDomain,
  canvasName: string,
  artifact?: ArtifactChange,
  nodeIds?: ReadonlyArray<string>,
): void => {
  for (const listener of listeners) listener(domain, canvasName, artifact, nodeIds);
};

/**
 * The Artifacts nodes an applied artifact ruling touched, from its facts: a
 * created artifact's node, both ends of a move, a coloured label's node. The
 * facts that name only the artifact are on the command's target node: the
 * ruler refuses one whose artifact sits elsewhere (artifact-domain.ts). The
 * switch is exhaustive, so a new fact must say which nodes it touches or the
 * typecheck fails. One the types still did not know (undefined) means the
 * whole canvas: it runs after the write committed, so it must never throw.
 */
export const artifactNodesOf = (targetNodeId: string, facts: ReadonlyArray<ArtifactFact>): ReadonlyArray<string> | undefined => {
  const nodes = new Set<string>();
  for (const fact of facts) {
    switch (fact.fact) {
      case "artifact.created":
        nodes.add(fact.artifact.nodeId);
        break;
      case "artifact.moved":
        nodes.add(fact.from);
        nodes.add(fact.to);
        break;
      case "artifact.label.coloured":
        nodes.add(fact.nodeId);
        break;
      case "artifact.edited":
      case "artifact.retitled":
      case "artifact.labelled":
      case "artifact.archived":
      case "artifact.tasks":
        nodes.add(targetNodeId);
        break;
      default: {
        const unnamed: never = fact;
        void unnamed;
        // A full re-read, never a lie about the write.
        return undefined;
      }
    }
  }
  return [...nodes];
};

/** Returns the unsubscribe. */
export const onResourceChanged = (listener: ResourceChangeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A comment landed on a resource whose own rows did not change: the threads of its kind did. */
export type ThreadChangeListener = (kind: ThreadResourceSubject["kind"], canvasName: string) => void;

const threadListeners = new Set<ThreadChangeListener>();

export const noteThreadChanged = (kind: ThreadResourceSubject["kind"], canvasName: string): void => {
  for (const listener of threadListeners) listener(kind, canvasName);
};

/** Returns the unsubscribe. */
export const onThreadChanged = (listener: ThreadChangeListener): (() => void) => {
  threadListeners.add(listener);
  return () => {
    threadListeners.delete(listener);
  };
};
