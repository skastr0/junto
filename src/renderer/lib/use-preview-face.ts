import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { mentionKey, type MentionRef } from "@shared/mention";
import type { Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { TaskNodeId } from "@shared/task-model";
import { SeatUrgency } from "@shared/wire/urgency";
import { agentSeat$ } from "./agent-seat-state";
import { useSeatSignalRollup } from "./agent-signals-state";
import { artifactsSource } from "./artifacts-source";
import { kernel$ } from "./kernel-view";
import { artifactFirstLines, taskLedgerOf, type PreviewCardFace } from "./preview-face";
import { seatFactsForNode, cardMark } from "./seat-projections";
import { seatSaying, seatUrgency } from "./seat-line";
import { tasksSource } from "./tasks-source";
import { terminal$ } from "./terminal-state";
import { useThreadHealthMark } from "./thread-health";
import { nodeAt, useNodeValue } from "./use-model";

// The live face for a mention: ref in, face out. The document's block embeds and the pad's cards
// both read through here, so neither resolves a face itself. Every read runs on every render, keyed
// off the ref, so the ref may change kind between renders without breaking the hook order.

type Held = { readonly key: string; readonly face: PreviewCardFace | "gone" | undefined };

const seatOf = (node: Node | undefined) => (node?.kind === "agent" ? node : undefined);
const pageOf = (node: Node | undefined) => (node?.kind === "page" ? node : undefined);

/** A seat's name and harness, read when the card is drawn: the face carries names, not ids alone. */
const assigneeOf = (canvasName: string, seat: string): { readonly id: string; readonly name: string; readonly harness?: string } => {
  const node = seatOf(nodeAt(canvasName, seat));
  if (node === undefined) return { id: seat, name: "a removed seat" };
  return node.harness === undefined ? { id: seat, name: titleOf(node) } : { id: seat, name: titleOf(node), harness: node.harness };
};

/** Read a task or an artifact off its source, and again on every change to it. Undefined until the first read lands. */
const useSourcedFace = (ref: MentionRef | undefined, canvasName: string): Held["face"] => {
  const key = ref === undefined || (ref.kind !== "task" && ref.kind !== "artifact") ? "" : `${canvasName}\u0000${mentionKey(ref)}`;
  const [held, setHeld] = useState<Held>({ key, face: undefined });
  const refRef = useRef(ref);
  refRef.current = ref;
  useEffect(() => {
    const ref = refRef.current;
    if (key === "" || ref === undefined) return;
    let live = true;
    let generation = 0;
    const land = (face: PreviewCardFace | "gone", mine: number): void => {
      if (live && mine === generation) setHeld({ key, face });
    };
    const read = async (): Promise<PreviewCardFace | "gone"> => {
      if (ref.kind === "task") {
        const tasks = await tasksSource().list(canvasName, ref.nodeId as TaskNodeId);
        const task = tasks.find((candidate) => candidate.taskId === ref.taskId);
        if (task === undefined) return "gone";
        const { assignee } = task.current;
        return {
          kind: "task",
          id: task.taskId,
          ...(task.number === undefined ? {} : { number: task.number }),
          title: task.title,
          state: task.current.state,
          ...(assignee === undefined ? {} : { assignee: assigneeOf(canvasName, assignee) }),
          ledger: taskLedgerOf(task),
        };
      }
      if (ref.kind === "artifact") {
        const heads = await artifactsSource().list(canvasName, ref.nodeId);
        const head = heads.find((candidate) => candidate.artifact.artifactId === ref.artifactId);
        if (head === undefined) return "gone";
        const { artifact } = head;
        const body = head.body ?? (await artifactsSource().body(canvasName, artifact.artifactId, artifact.version));
        return {
          kind: "artifact",
          id: artifact.artifactId,
          type: artifact.type,
          title: artifact.title,
          version: artifact.version,
          lines: body === null ? [] : artifactFirstLines(body),
        };
      }
      return "gone";
    };
    const refresh = (): void => {
      const mine = ++generation;
      read().then(
        (face) => land(face, mine),
        () => land("gone", mine),
      );
    };
    refresh();
    const unsubscribe =
      ref.kind === "task"
        ? tasksSource().subscribe(refresh)
        : artifactsSource().onChanged((changed) => {
            if (changed.canvasName === canvasName) refresh();
          });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [key, canvasName]);
  return held.key === key ? held.face : undefined;
};

/**
 * The face a mention draws. `ref` undefined is a link whose node is gone or names nothing: the
 * card is drawn missing, under the link's label. A task or an artifact reads `loading` until its
 * source answers; a seat and a page are on the canvas already.
 */
export function usePreviewFace(ref: MentionRef | undefined, canvasName: string, label: string): PreviewCardFace {
  const nodeId = ref?.nodeId ?? "";
  // One primitive per read: a node that moves on the canvas repaints nothing here.
  const seatBinding = useNodeValue(canvasName, nodeId, (node) => seatOf(node)?.bindingId);
  const seatName = useNodeValue(canvasName, nodeId, (node) => {
    const agent = seatOf(node);
    return agent === undefined ? undefined : titleOf(agent);
  });
  const seatHarness = useNodeValue(canvasName, nodeId, (node) => seatOf(node)?.harness);
  const pageTitle = useNodeValue(canvasName, nodeId, (node) => {
    const found = pageOf(node);
    return found === undefined ? undefined : titleOf(found);
  });
  const pageUrl = useNodeValue(canvasName, nodeId, (node) => pageOf(node)?.url);
  const bindingId = ref?.kind === "seat" ? seatBinding : undefined;
  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? ""]);
  const needsLook = use$(() => agentSeat$.needsLookByBindingId[bindingId ?? ""].get() === true);
  const session = use$(terminal$.sessionByBindingId[bindingId ?? ""]);
  const graphBlocked = use$(() => bindingId !== undefined && kernel$.execution.get()?.blocked.includes(nodeId) === true);
  const rollup = useSeatSignalRollup(canvasName, ref?.kind === "seat" ? nodeId : "");
  const health = useThreadHealthMark(bindingId, rollup?.kind);
  const sourced = useSourcedFace(ref, canvasName);

  const missing = (reason: "loading" | "gone"): PreviewCardFace =>
    ref === undefined ? { kind: "missing", label, reason } : { kind: "missing", label, reason, of: ref.kind };
  if (ref === undefined) return missing("gone");
  switch (ref.kind) {
    case "seat": {
      if (seatName === undefined) return missing("gone");
      const activity = cardMark(seatFactsForNode({ nodeId, seatEvent, session, needsLook, graphBlocked, managedSeat: seatHarness !== undefined }));
      const failure = seatHarness !== undefined && session?.exitReason && session.exitMessage ? session.exitMessage : undefined;
      const said = seatEvent?.state === "attention" && seatEvent.reason ? { ...activity, label: seatEvent.reason } : activity;
      const saying = seatSaying({ activity: said, signal: rollup?.signal, failure, health });
      return {
        kind: "seat",
        id: nodeId,
        name: seatName,
        ...(seatHarness === undefined ? {} : { harness: seatHarness }),
        state: seatUrgency({ activity: said, signal: rollup?.kind, failure }),
        line: saying.kind === "reading" ? `AI reads ${saying.text}` : saying.text,
      };
    }
    case "page":
      return pageTitle === undefined
        ? missing("gone")
        : { kind: "page", id: nodeId, title: pageTitle, ...(pageUrl === undefined ? {} : { url: pageUrl }), state: SeatUrgency.group.resting };
    case "task":
    case "artifact":
      return sourced === undefined ? missing("loading") : sourced === "gone" ? missing("gone") : sourced;
  }
}
