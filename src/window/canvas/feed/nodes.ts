/**
 * Non-seat node chrome, derived from the stores with no card mounted:
 * the status tag and spoken kind every card publishes (node-status.ts) and
 * the urgency a region frame leans to (node-urgency.ts's store). Agent seats
 * publish their own urgency in seats.ts; files and git keep their card-side
 * publish because their "off" is a per-card read (a files count, a git IPC),
 * not canvas state.
 */
import { observe } from "@legendapp/state";
import { BROWSER_ENABLED } from "@shared/features";
import { formatNodeRef } from "@shared/node-ref";
import type { NodeId } from "@shared/physics/schema";
import { RegionUrgency } from "@shared/wire/urgency";
import { agentSeat$ } from "../../lib/agent-seat-state";
import type { AutomationListResponse } from "@shared/automation";
import { browser$ } from "../../lib/browser-state";
import { dock$ } from "../../lib/dock-state";
import { machineLabelIn } from "../../lib/machines";
import { modelStore } from "../../lib/use-model";
import { kindMayBeBlocked } from "../../lib/model-kind";
import {
  publishNodeSpokenKind,
  publishNodeStatus,
  shownStatus,
  type NodeStatus,
} from "../../lib/node-status";
import { pageDriving$ } from "../../lib/page-driving";
import { publishNodeUrgency, type Urgency } from "../../lib/region-urgency";
import { seatCardStatus } from "../../lib/seat-card-status";
import { canvasTasks$ } from "../../lib/seat-tasks";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { tasksCardBody } from "../../components/tasks/tasks-pane-model";
import { blockedNodeIds } from "./shared";
import { retainAutomationFacts } from "./automations";

/** One field of a model node, tracked when read inside `observe`. */
const field = <T>(node$: unknown, name: string): T | undefined =>
  (node$ as Record<string, { get(): T | undefined }>)[name]?.get();

/** The Automations card's status word from its one list read; `nameOf` only names rows. */
const automationStatus = (list: AutomationListResponse | undefined): NodeStatus | undefined => {
  if (list === undefined) return undefined;
  const failed = list.automations.filter(
    (automation) => list.lastOutcomes?.[automation.automationId] === "failed",
  ).length;
  if (failed > 0) return "failed";
  const on = list.automations.filter((automation) => automation.enabled).length;
  return list.automations.length > 0 && on === 0 ? "off" : undefined;
};

export const retainNodeChrome = (canvasName: string): (() => void) => {
  // The automations nodes' list reads, shared with the kind live facts
  // (feed/automations.ts): one retention per canvas, refcounted.
  const automations = retainAutomationFacts(canvasName);

  const previous = {
    status: new Map<string, NodeStatus | undefined>(),
    spoken: new Map<string, string | undefined>(),
    urgency: new Map<string, Urgency | undefined>(),
  };

  const offNodes = observe(() => {
    const model = modelStore.canvas$(canvasName);
    const ids = model.nodeIds.get();
    agentSeat$.rev.get();
    const blocked = blockedNodeIds(canvasName);
    const tasksByNode = canvasTasks$.byNode.get();
    const sessionByBinding = terminal$.sessionByBindingId.get();
    const machines = state$.machines.get();
    const automationReads = automations.facts.get();
    const browserSessions = browser$.sessionByRef.get();
    const opErrors = dock$.opErrorByRef.get();
    const workingByRef = pageDriving$.workingByRef.get();

    const next = {
      status: new Map<string, NodeStatus | undefined>(),
      spoken: new Map<string, string | undefined>(),
      urgency: new Map<string, Urgency | undefined>(),
    };

    for (const id of ids) {
      const node$ = model.nodes[id];
      const kind = field<string>(node$, "kind");
      if (kind === undefined) continue;
      const blockedHere = blocked.has(id);
      const shellBlocked = blockedHere && kindMayBeBlocked(kind as never);
      let reported: NodeStatus | undefined;
      let spoken: string | undefined;
      let urgency: Urgency | undefined;

      switch (kind) {
        case "terminal": {
          const bindingId = field<string>(node$, "bindingId");
          const name = field<string>(node$, "label") ?? "";
          const launch = field<{ readonly kind: string; readonly argv?: readonly string[] }>(node$, "launch");
          const seatEvent = bindingId === undefined ? undefined : agentSeat$.byBindingId[bindingId].peek();
          const needsLook = bindingId !== undefined && agentSeat$.needsLookByBindingId[bindingId].peek() === true;
          const session = bindingId === undefined ? undefined : sessionByBinding[bindingId];
          const status = seatCardStatus({
            face: bindingId === undefined ? undefined : { id, name, bindingId, launch },
            seatEvent,
            needsLook,
            session,
            graphBlocked: blockedHere,
          });
          const running = session?.status === "running" || session?.status === "starting";
          const spineStatus: NodeStatus | undefined = blockedHere
            ? "blocked"
            : status?.seatState === "attention"
              ? "needs-you"
              : status?.seatState === "working" || running
                ? "working"
                : undefined;
          reported = spineStatus;
          urgency =
            spineStatus === "blocked"
              ? RegionUrgency.group.blocked
              : spineStatus === "needs-you"
                ? RegionUrgency.group["needs-you"]
                : undefined;
          break;
        }
        case "task": {
          const body = tasksCardBody(tasksByNode[id] ?? []);
          reported = body.status;
          urgency =
            body.status === "blocked"
              ? RegionUrgency.group.blocked
              : body.status === "needs-you"
                ? RegionUrgency.group["needs-you"]
                : undefined;
          break;
        }
        case "automations": {
          const status = automationStatus(automationReads[id]);
          reported = status;
          urgency = status === "failed" ? RegionUrgency.group.blocked : undefined;
          break;
        }
        case "page": {
          if (BROWSER_ENABLED) {
            let pageRef: string | undefined;
            try {
              pageRef = formatNodeRef({ canvasName, nodeId: id as NodeId });
            } catch {
              pageRef = undefined;
            }
            if (pageRef !== undefined) {
              const session = browserSessions[pageRef];
              const opError = opErrors[pageRef];
              const working = workingByRef[pageRef] ?? false;
              const err = opError?.message ?? (session?.state === "failed" ? session.lastError : undefined);
              reported = err !== undefined ? "failed" : working ? "working" : undefined;
              urgency = err !== undefined ? RegionUrgency.group.blocked : undefined;
            }
          }
          break;
        }
        case "peer": {
          const host = field<string>(node$, "host");
          if (host !== undefined) spoken = `seat on ${machineLabelIn(machines, host)}`;
          break;
        }
        case "stub": {
          const of = field<string>(node$, "of") ?? "node";
          const host = field<string>(node$, "host");
          const where = host === undefined ? undefined : machineLabelIn(machines, host);
          spoken = where === undefined ? `${of} copy` : `${of} copy on ${where}`;
          break;
        }
        default:
          break;
      }

      next.status.set(id, shownStatus(reported, shellBlocked));
      next.spoken.set(id, spoken);
      next.urgency.set(id, urgency);
    }

    for (const id of previous.status.keys()) {
      if (!next.status.has(id)) publishNodeStatus(id, undefined);
    }
    for (const [id, value] of next.status) publishNodeStatus(id, value);
    for (const id of previous.spoken.keys()) {
      if (!next.spoken.has(id)) publishNodeSpokenKind(id, undefined);
    }
    for (const [id, value] of next.spoken) publishNodeSpokenKind(id, value);
    for (const id of previous.urgency.keys()) {
      if (!next.urgency.has(id)) publishNodeUrgency(id, undefined);
    }
    for (const [id, value] of next.urgency) publishNodeUrgency(id, value);
    previous.status = next.status;
    previous.spoken = next.spoken;
    previous.urgency = next.urgency;
  });

  return () => {
    offNodes();
    automations.release();
    for (const id of previous.status.keys()) publishNodeStatus(id, undefined);
    for (const id of previous.spoken.keys()) publishNodeSpokenKind(id, undefined);
    for (const id of previous.urgency.keys()) publishNodeUrgency(id, undefined);
  };
};
