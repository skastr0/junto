import type { ArtifactType } from "./artifact";
import { artifactLinkTitle } from "./wire/artifact-link";

/** The `[[ ]]` link itself is a wire value (`./wire/artifact-link.ts`), one definition for the desktop and the phone. */
export { artifactLink, artifactLinkLabel, artifactLinkTitle } from "./wire/artifact-link";

// --- what a link names now ---------------------------------------------------

/** What a reader knows of an artifact a link names: one entry of its Artifacts node's list. */
export type LinkedArtifactHead = {
  readonly artifactId: string;
  readonly title: string;
  readonly type: ArtifactType;
  readonly archived: boolean;
};

/**
 * One link state for every surface that draws an artifact link (document,
 * pad, sheet): `unread` until its node is read (the words it was written
 * with), `live`, `archived` (still opens, read-only), or `missing` (the node
 * or the artifact is gone, or never held it). A missing link claims no title.
 */
export type ArtifactLinkState =
  | { readonly state: "unread"; readonly words: string }
  | { readonly state: "live"; readonly words: string; readonly type: ArtifactType }
  | { readonly state: "archived"; readonly words: string; readonly type: ArtifactType }
  | { readonly state: "missing"; readonly words: string };

/** What a missing link says in place of a title. */
export const MISSING_ARTIFACT_WORDS = "Missing artifact";

/** What opening a missing link says. */
export const ARTIFACT_GONE_LINE = "This artifact is gone: it was deleted, or the link names one that never existed.";

/**
 * The state of a link to `artifactId`, from what its node holds: `heads`
 * undefined while the node is unread, null when the node is gone or is not
 * an Artifacts node. `written` is the link's label as written (`[[Title]]`
 * or `#Title`); a `[[ ]]` link and a `#` mention resolve alike, words aside:
 * the words are the title as it is now.
 */
export const artifactLinkStateOf = (
  artifactId: string,
  heads: ReadonlyArray<LinkedArtifactHead> | null | undefined,
  written: string,
): ArtifactLinkState => {
  if (heads === undefined) return { state: "unread", words: artifactLinkTitle(written) ?? written.replace(/^#/u, "") };
  const head = heads?.find((entry) => entry.artifactId === artifactId);
  if (head === undefined) return { state: "missing", words: MISSING_ARTIFACT_WORDS };
  return { state: head.archived ? "archived" : "live", words: head.title, type: head.type };
};
