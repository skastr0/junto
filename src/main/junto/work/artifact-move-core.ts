/**
 * The operator's artifact move where the store is: the overseer's
 * `artifact.move` and the window's "Move to" reach the same `moveArtifacts`
 * on the core's own runner. It holds no operation registration, so a module
 * that only needs the move (the overseer's dispatch) links no operation body.
 */
import type { ArtifactMoveRun } from "@shared/artifact-move";
import { coreRunner } from "../../core-runner";
import { moveArtifacts } from "./artifact-move";
import { workResourcePorts } from "./resource-ports";

export const coreArtifactMove: ArtifactMoveRun = (input, by) =>
  coreRunner.runPromise(workResourcePorts((ports) => moveArtifacts(ports, input, by)));
