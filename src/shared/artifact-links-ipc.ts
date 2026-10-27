/**
 * Body backlinks over IPC (0.11, 02, L1): the artifacts whose head body links
 * one artifact, newest change first. Main reads `work_artifact_links`
 * (`work/body-links.ts`); the window reads only. The mail side of "Linked
 * from" is `mentions` and stays its own read, so a pane shows the two lists
 * side by side.
 */
import { Schema } from "effect";
import type { ArtifactLinkRef, LinkedFromBody } from "./artifact-links";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export { ARTIFACT_LINKS_IPC_CHANNELS } from "./artifact-links-ipc-channels";

/** The artifact asked about: the node that shows it and its own id. */
export const ArtifactLinksInput = Schema.Struct({
  canvasName: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128))),
  nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256))),
  artifactId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
}).annotate(strict);

/** Said to every window after a body link lands or leaves on a canvas. */
export type ArtifactLinksChanged = { readonly canvasName: string };

export type ArtifactLinksApi = {
  /** The artifacts whose head body links `target`, newest change first; archived sources left out. */
  readonly linkedFrom: (canvasName: string, target: ArtifactLinkRef) => Promise<ReadonlyArray<LinkedFromBody>>;
  readonly onChanged: (listener: (changed: ArtifactLinksChanged) => void) => () => void;
};
