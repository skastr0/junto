// Target text to mentions for automation definitions (plan 07, cli L4).
// Every target an automation names must be one of `automationTargets`: at or
// below the automation's node and, when a seat wrote it, in that seat's reach.
// Pure: it reads the canvas it is handed and nothing else.

import { mentionRefOf, parseMentionHref, type MentionRef } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import type { Canvas, Node } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets, type AutomationAuthor } from "@shared/region-reach";
import {
  WANTED_KINDS,
  wrongKindRefusal,
  type NodeText,
  type TargetResolver,
  type TargetText,
  type TargetWant,
} from "@shared/automation-control";
import type { WorkErrorBody } from "@shared/work-control";

const CANDIDATES_SHOWN = 12;

const namesOf = (nodes: ReadonlyArray<Node>): string =>
  nodes.slice(0, CANDIDATES_SHOWN).map(titleOf).join(", ") +
  (nodes.length > CANDIDATES_SHOWN ? `, and ${nodes.length - CANDIDATES_SHOWN} more` : "");

const outOfReach = (text: string, path: string): WorkErrorBody => ({
  type: "ScopeError",
  message: `${text} is not below this automation or not in its author's reach`,
  details: {
    path,
    reason: "out_of_reach",
    retryable: false,
    next_step: "name a seat or resource in the automation's region or a region below it",
  },
});

/**
 * Resolve target text against what this automation may act on. `@name` names
 * a seat by its exact name; a `junto://` link names any node, with `&item=`
 * for a task or an artifact. `#42` waits for task numbers (plan 04).
 */
export const automationTargetResolver = (
  canvas: Canvas,
  automationNode: NodeId,
  author: AutomationAuthor,
): TargetResolver => {
  const allowed = new Map<NodeId, Node>();
  for (const target of automationTargets(canvas, automationNode, author)) {
    const node = canvas.nodes.get(target.id);
    if (node !== undefined) allowed.set(node.id, node);
  }
  const seats = [...allowed.values()].filter((node) => node.kind === "agent" || node.kind === "peer");
  const kindOf = (nodeId: NodeId) => canvas.nodes.get(nodeId)?.kind;

  const ref = (text: TargetText, want: TargetWant, path: string): MentionRef | WorkErrorBody => {
    if (text.startsWith("#")) {
      return {
        type: "InputError",
        message: "task numbers are not minted yet",
        details: {
          path,
          reason: "not_available",
          received: text,
          retryable: false,
          next_step: "name the task by its junto:// link with &item=",
        },
      };
    }
    if (text.startsWith("@")) {
      const name = text.slice(1);
      const named = seats.filter((seat) => titleOf(seat) === name);
      if (named.length === 1) {
        return want === "seat" ? { kind: "seat", nodeId: named[0]!.id } : wrongKindRefusal(text, want, "seat", path);
      }
      return {
        type: named.length === 0 ? "UnknownTarget" : "InputError",
        message: named.length === 0
          ? `no seat named ${name} is below this automation`
          : `${named.length} seats are named ${name}; name one by its junto:// link`,
        details: {
          path,
          received: text,
          retryable: false,
          ...(seats.length === 0 ? {} : { hint: `seats it can name: ${namesOf(seats)}` }),
        },
      };
    }
    const target = parseMentionHref(text);
    if (target === undefined) {
      return {
        type: "InputError",
        message: `${text} is not a junto:// link to a node`,
        details: { path, received: text, retryable: false },
      };
    }
    const mention = mentionRefOf(target, kindOf);
    if (mention === undefined) {
      return {
        type: "UnknownTarget",
        message: `${text} names no seat, task, artifact or page on this canvas`,
        details: { path, received: text, retryable: false },
      };
    }
    if (!(WANTED_KINDS[want] as ReadonlyArray<MentionRef["kind"]>).includes(mention.kind)) {
      return wrongKindRefusal(text, want, mention.kind, path);
    }
    if (mention.kind === "page") {
      // automationTargets holds seats and resources; a page stays edge-bound (plan 06).
      return {
        type: "InputError",
        message: `${text} is a page, and an automation does not act on pages in this release`,
        details: { path, reason: "not_available", received: "page", retryable: false },
      };
    }
    return allowed.has(mention.nodeId) ? mention : outOfReach(text, path);
  };

  const node = (text: NodeText, path: string): NodeId | WorkErrorBody => {
    const byLink = text.startsWith("junto://") ? parseMentionHref(text) : undefined;
    const boards = [...allowed.values()].filter((candidate) => candidate.kind === "task");
    const named = byLink !== undefined
      ? boards.filter((board) => board.id === byLink.nodeId && byLink.item === undefined)
      : boards.filter((board) => board.id === text || titleOf(board) === text);
    if (named.length === 1) return named[0]!.id;
    const exists = [...canvas.nodes.values()].some((candidate) =>
      candidate.kind === "task" && (candidate.id === (byLink?.nodeId ?? text) || titleOf(candidate) === text));
    if (exists && named.length === 0) return outOfReach(text, path);
    return {
      type: named.length === 0 ? "UnknownTarget" : "InputError",
      message: named.length === 0
        ? `no tasks node ${text} is below this automation`
        : `${named.length} tasks nodes are named ${text}; name one by its id`,
      details: {
        path,
        received: text,
        retryable: false,
        ...(boards.length === 0 ? {} : { hint: `tasks nodes it can name: ${namesOf(boards)}` }),
      },
    };
  };

  return { ref, node };
};
