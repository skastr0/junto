import type { Canvas } from "./model";

/** The far machine's own placement of work on the installation being replaced. */
export interface TakeoverAutomation {
  readonly archived: boolean;
  readonly automation: { readonly machine?: string };
}

export interface TakeoverSource {
  readonly canvas: Canvas;
  readonly automations: ReadonlyMap<string, TakeoverAutomation>;
}

/**
 * What the far machine's canvases place on `name`: seats hosted there, and
 * unarchived automations that run there. These are the counts the operator
 * confirms before the pin is replaced.
 */
export const countTakeoverPlacement = (name: string, sources: ReadonlyArray<TakeoverSource>) => {
  let seats = 0;
  let automations = 0;
  let files = 0;
  for (const source of sources) {
    for (const node of source.canvas.nodes.values()) {
      if ((node.kind === "agent" || node.kind === "peer") && node.host === name) seats += 1;
      if (node.kind === "files" && node.host === name) files += 1;
    }
    for (const entry of source.automations.values()) {
      if (!entry.archived && entry.automation.machine === name) automations += 1;
    }
  }
  return { seats, automations, files };
};
