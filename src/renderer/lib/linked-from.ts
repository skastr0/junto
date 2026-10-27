/**
 * Body backlinks, read (0.11 artifact links, L4): the artifacts whose body
 * links to an artifact, newest first, from main's `work_artifact_links`
 * (`window.junto.artifactLinks`, L1). Mail and comments stay with
 * `useMentionedIn`. Without the bridge the source answers empty; tests
 * install their own.
 */
import { useEffect, useRef, useState } from "react";
import type { ArtifactLinkRef, LinkedFromBody } from "@shared/artifact-links";
import type { ArtifactLinksApi } from "@shared/artifact-links-ipc";
import { artifactLinkTitle } from "@shared/artifact-link";
import { mentionLinksOf } from "@shared/mention";
import { getJuntoApi } from "./junto-api";

export type ArtifactTarget = ArtifactLinkRef;
export type BodyLink = LinkedFromBody;

/**
 * A body's line as a reader sees it, as the editors draw it: a `[[ ]]` link
 * says its artifact's title now (`titleOf`), or the title it was written with
 * until that is known, without the brackets; any other link shows its label.
 * A link the line bound cut through keeps the label it got.
 */
export const readableLine = (line: string, titleOf?: (target: ArtifactTarget) => string | undefined): string => {
  let shown = "";
  let at = 0;
  for (const link of mentionLinksOf(line)) {
    const written = artifactLinkTitle(link.label);
    const now = written === undefined || link.target.item === undefined ? undefined : titleOf?.({ nodeId: link.target.nodeId, artifactId: link.target.item });
    shown += line.slice(at, link.start) + (written === undefined ? link.label : (now ?? written));
    at = link.end;
  }
  shown += line.slice(at);
  return shown.replace(/\[([^\]\n]*)\]\([^)\s]*$/u, "$1…").trim();
};

export type BodyLinksSource = ArtifactLinksApi;

const NONE: BodyLinksSource = { linkedFrom: async () => [], onChanged: () => () => undefined };

let installed: BodyLinksSource | null = null;

/** Tests set the source; null goes back to the bridge. */
export const installBodyLinks = (source: BodyLinksSource | null): void => {
  installed = source;
};

const bridged = (): BodyLinksSource | undefined => getJuntoApi()?.artifactLinks;

export const bodyLinksSource = (): BodyLinksSource => installed ?? bridged() ?? NONE;

/** The target's body backlinks, read again whenever main says links changed on the canvas; a late read never overwrites a newer one. */
export const useBodyLinks = (
  canvasName: string,
  target: ArtifactTarget,
): { readonly links: ReadonlyArray<BodyLink>; readonly loaded: boolean } => {
  const key = `${canvasName}\u0000${target.nodeId}\u0000${target.artifactId}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const [held, setHeld] = useState<{ readonly key: string; readonly links: ReadonlyArray<BodyLink>; readonly loaded: boolean }>({
    key,
    links: [],
    loaded: false,
  });
  useEffect(() => {
    const source = bodyLinksSource();
    let live = true;
    let latest = 0;
    const read = (): void => {
      const mine = ++latest;
      void source.linkedFrom(canvasName, targetRef.current).then(
        (links) => {
          if (live && mine === latest) setHeld({ key, links, loaded: true });
        },
        () => undefined,
      );
    };
    read();
    const off = source.onChanged((event) => {
      if (event.canvasName === canvasName) read();
    });
    return () => {
      live = false;
      off();
    };
  }, [canvasName, key]);
  return held.key === key ? held : { links: [], loaded: false };
};
