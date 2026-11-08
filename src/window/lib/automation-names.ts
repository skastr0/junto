/**
 * How an automation names the things it reaches, in words. Its own small
 * module so the canvas card reads it without loading the editor.
 */
import { useMemo } from "react";
import { mentionKey } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import type { NameOf, NodeScope, TargetRef } from "./automation-editor";
import type { MentionCandidate } from "./mention-draft";
import { useCanvas } from "./use-model";

/**
 * Labels for every target this automation may name, and a fallback for one it
 * no longer reaches. A node a watch covers whole reads by its own name.
 */
export const useTargetNames = (
  candidates: ReadonlyArray<MentionCandidate>,
  canvasName: string,
): NameOf => {
  const canvas = useCanvas(canvasName);
  return useMemo(() => {
    const labels = new Map(candidates.map((candidate) => [mentionKey(candidate.ref), candidate.label]));
    return (ref: TargetRef | NodeScope) => {
      if (!("kind" in ref)) {
        const node = canvas.nodes.get(ref.node);
        return node ? titleOf(node) : "a node out of reach";
      }
      const known = labels.get(mentionKey(ref));
      if (known) return known;
      const node = canvas.nodes.get(ref.nodeId);
      return node ? `${ref.kind === "seat" || ref.kind === "page" ? "@" : "#"}${titleOf(node)}` : "something out of reach";
    };
  }, [candidates, canvas]);
};
