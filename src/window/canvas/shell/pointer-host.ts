/**
 * What the pointer machine asks of the window: whether two cards may be
 * joined, which verbs their pair admits, and what rides with a region.
 *
 * The engine may import only `src/shared/` and its own folder, so these three
 * answers (they live in `lib/edge-mutations.ts` and `lib/model-edits.ts`)
 * reach it through the host. They read the open canvas as it stands.
 */

import type { EngineHost } from "../engine/engine";
import type { NodeId } from "../contract";
import { canConnect, verbsForDraw } from "../../lib/edge-mutations";
import { heldBy } from "../../lib/model-edits";
import { physicsKind } from "../../lib/model-kind";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";
import type { Node } from "@shared/model";

type Hands = NonNullable<EngineHost["hands"]>;

const nodeOf = (id: NodeId): Node | undefined => {
  const name = state$.canvasName.peek();
  if (name === "") return undefined;
  return modelStore.canvasOf(name).nodes.get(id as never);
};

/** The three answers, for the engine's host. */
export const canvasHands = (): Hands => ({
  canConnect: (source, target) => canConnect(nodeOf(source), nodeOf(target)),
  verbsFor: (source, target) => {
    const from = nodeOf(source)?.kind;
    const to = nodeOf(target)?.kind;
    return verbsForDraw(from === undefined ? undefined : physicsKind(from), to === undefined ? undefined : physicsKind(to)).verbs;
  },
  riders: (regionId) => {
    const name = state$.canvasName.peek();
    return name === "" ? [] : heldBy(modelStore.canvasOf(name), regionId);
  },
});
