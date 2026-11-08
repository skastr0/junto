/**
 * What an action's `{{name}}` values say at firing time (plan 0.11/05). Main
 * resolves them here from the change that fired the automation and the
 * task or artifact it names, never in the renderer. A value is inserted as
 * text, in one pass (`resolveValues`), so a title holding `{{x}}` stays
 * `{{x}}`. A value the firing does not carry (a `run` of a change
 * automation has no change) stays as written.
 *
 * An answered signal (0.11/09) says the answer and its signal, and
 * `raised.<name>` what its raising firing said, kept on that firing's
 * `raised` ruling. A secret's answer says only the name it set.
 */
import { AUTOMATION_VALUES, isCodeValueName, isRaisedValueName, type CodeOutput, type FiringCause, type ValueName } from "@shared/automation";
import { formatNodeRef } from "@shared/node-ref";
import { mentionLink, type MentionRef } from "@shared/mention";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { TaskView } from "@shared/task-model";
import type { ItemId } from "@shared/work-ids";
import type { ArtifactHeadRead } from "../work/artifact-repository";
import type { ChangeEvent } from "./plan";

/** The change that fired an automation, if a change did, when it fired, and what its code steps so far answered. */
export type Fired = {
  readonly event?: ChangeEvent;
  readonly at: number;
  /** Why it fired; a code step's input says it. */
  readonly cause?: FiringCause["kind"];
  readonly code?: CodeOutput;
  /**
   * Delivering an answer where its signal step says: the step's own values
   * are the raising firing's, so `fired.at` is when it raised the signal.
   */
  readonly delivering?: boolean;
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

/** What a link's label may not hold, escaped as a mention link escapes it. */
const label = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (c) => `\\${c}`);

const ANSWERED: ReadonlyArray<string> = AUTOMATION_VALUES.answered;

/** An answered signal's own values: the answer, by whom and when, and the signal it answered. */
const answeredValue = (name: string, event: Extract<ChangeEvent, { readonly kind: "answered" }>, canvasName: string): string | undefined => {
  const { signal } = event;
  const response = signal.response;
  switch (name) {
    case "answer.text":
      // A secret's value never reaches a value: only the name it set.
      if (response?.secret !== undefined) return `${response.secret.name} is set`;
      return response?.text;
    case "answer.link": {
      if (response?.artifact !== undefined) {
        const { nodeId, artifactId, title } = response.artifact;
        return linkOf({ kind: "artifact", nodeId: nodeId as NodeId, artifactId: artifactId as ItemId }, title, canvasName);
      }
      return (response?.links ?? []).join("\n");
    }
    case "answer.by":
      return "operator";
    case "answer.at": {
      const at = response?.at ?? signal.closedAt;
      return at === undefined ? undefined : new Date(at).toISOString();
    }
    case "signal.title":
      return signal.text;
    case "signal.kind":
      return signal.kind;
    case "signal.link":
      try {
        return `[${label(signal.text)}](${formatNodeRef({ canvasName, nodeId: event.nodeId })})`;
      } catch {
        return signal.text;
      }
    default:
      return undefined;
  }
};

/** Each value as this firing says it, or undefined when the firing does not carry it. */
export const firedValue = (
  name: ValueName,
  fired: Fired,
  reads: FiredReads,
  canvas: Canvas | undefined,
  canvasName: string,
): string | undefined => {
  const event = fired.event;
  if (isRaisedValueName(name)) return event?.kind === "answered" ? event.raised[name.slice("raised.".length)] : undefined;
  if (event?.kind === "answered") {
    if (ANSWERED.includes(name)) return answeredValue(name, event, canvasName);
    // Delivering, the step's own values are the raising firing's.
    if (fired.delivering === true) return event.raised[name];
  }
  if (isCodeValueName(name)) {
    const value = fired.code?.[name.slice("code.".length)];
    return value === undefined ? undefined : String(value);
  }
  if (name === "fired.at") return new Date(fired.at).toISOString();
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
    case "answered":
    case undefined:
      return undefined;
    default:
      return event satisfies never;
  }
};
