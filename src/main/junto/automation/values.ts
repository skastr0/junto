/**
 * What an action's `{{name}}` values say at firing time (plan 0.11/05). Main
 * resolves them here from the change that fired the automation and the
 * task or artifact it names, never in the renderer. A value is inserted as
 * text, in one pass (`resolveValues`), so a title holding `{{x}}` stays
 * `{{x}}`. A value the firing does not carry (a `run` of a change
 * automation has no change) stays as written.
 */
import { isCodeValueName, type CodeOutput, type FiringCause, type ValueName } from "@shared/automation";
import { mentionLink, type MentionRef } from "@shared/mention";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { TaskView } from "@shared/task-model";
import type { ArtifactHeadRead } from "../work/artifact-repository";
import type { ChangeEvent } from "./plan";

/** The change that fired an automation, if a change did, when it fired, and what its code steps so far answered. */
export type Fired = {
  readonly event?: ChangeEvent;
  readonly at: number;
  /** Why it fired; a code step's input says it. */
  readonly cause?: FiringCause["kind"];
  readonly code?: CodeOutput;
};

/** What the firing's task or artifact reads as, fetched once for its actions. */
export type FiredReads = { readonly task?: TaskView; readonly artifact?: ArtifactHeadRead };

/** A link a seat can open, labelled with its name; the bare name when the canvas cannot word it. */
const linkOf = (ref: MentionRef, label: string, canvasName: string): string => {
  try {
    return mentionLink(ref, label, canvasName);
  } catch {
    return label;
  }
};

const nodeTitle = (canvas: Canvas | undefined, nodeId: NodeId): string | undefined => {
  const node = canvas?.nodes.get(nodeId);
  return node === undefined ? undefined : titleOf(node);
};

const seatLink = (canvas: Canvas | undefined, canvasName: string, seat: NodeId): string =>
  linkOf({ kind: "seat", nodeId: seat }, nodeTitle(canvas, seat) ?? seat, canvasName);

/** Each value as this firing says it, or undefined when the firing does not carry it. */
export const firedValue = (
  name: ValueName,
  fired: Fired,
  reads: FiredReads,
  canvas: Canvas | undefined,
  canvasName: string,
): string | undefined => {
  if (isCodeValueName(name)) {
    const value = fired.code?.[name.slice("code.".length)];
    return value === undefined ? undefined : String(value);
  }
  if (name === "fired.at") return new Date(fired.at).toISOString();
  const event = fired.event;
  switch (event?.kind) {
    case "task": {
      const task = reads.task;
      switch (name) {
        case "task.state":
          return event.becomes;
        case "board.title":
          return nodeTitle(canvas, event.nodeId);
        case "task.title":
          return task?.title;
        case "task.link":
          return task === undefined ? undefined : linkOf({ kind: "task", nodeId: event.nodeId, taskId: event.taskId }, task.title, canvasName);
        case "task.assignee":
          if (task === undefined) return undefined;
          return task.current.assignee === undefined ? "unassigned" : seatLink(canvas, canvasName, task.current.assignee);
        default:
          return undefined;
      }
    }
    case "artifact": {
      const title = reads.artifact?.artifact.title;
      switch (name) {
        case "artifacts.title":
          return nodeTitle(canvas, event.nodeId);
        case "artifact.title":
          return title;
        case "artifact.labels":
          return reads.artifact?.artifact.labels.join(", ");
        case "artifact.link":
          return title === undefined
            ? undefined
            : linkOf({ kind: "artifact", nodeId: event.nodeId, artifactId: event.artifactId }, title, canvasName);
        default:
          return undefined;
      }
    }
    case "seat":
      if (name === "seat.state") return event.becomes;
      if (name === "seat.name") return nodeTitle(canvas, event.seat) ?? event.seat;
      return undefined;
    case "signal":
      if (name === "signal.kind") return event.signal;
      if (name === "signal.text") return event.text;
      if (name === "signal.from") return seatLink(canvas, canvasName, event.seat);
      return undefined;
    case undefined:
      return undefined;
    default:
      return event satisfies never;
  }
};
