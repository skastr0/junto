import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource } from "./artifacts-source";
import { useCanvas } from "./use-model";

const NONE: ReadonlyArray<ArtifactHead> = [];

/**
 * Every artifact on the canvas, for quick capture's list (0.11, 11 Q1): each
 * Artifacts node's head rows, read once and again when an artifact changes.
 * The surface searches all of them, so a capture can find any document the
 * canvas holds without knowing which node it sits in.
 */
export const useCanvasArtifacts = (canvasName: string): ReadonlyArray<ArtifactHead> => {
  const canvas = useCanvas(canvasName);
  const nodes = useMemo(
    () => [...canvas.nodes.values()].filter((node) => node.kind === "artifacts").map((node) => node.id as NodeId),
    [canvas],
  );
  const key = nodes.join(",");
  const [heads, setHeads] = useState<ReadonlyArray<ArtifactHead>>(NONE);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    if (canvasName === "" || key === "") {
      setHeads(NONE);
      return;
    }
    let live = true;
    let reading = false;
    let again = false;
    const read = (): void => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      void Promise.all(nodesRef.current.map((nodeId) => artifactsSource().list(canvasName, nodeId))).then(
        (lists) => {
          reading = false;
          if (live) setHeads(lists.flat());
          if (again) {
            again = false;
            read();
          }
        },
        () => {
          reading = false;
          if (again) {
            again = false;
            read();
          }
        },
      );
    };
    read();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, key]);
  return heads;
};
