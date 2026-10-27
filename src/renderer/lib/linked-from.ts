/**
 * Body backlinks, read (0.11 artifact links, L4): the artifacts whose body
 * links to an artifact, newest first, from main's `work_artifact_links`
 * (L1, product-feed). Mail and comments stay with `useMentionedIn`.
 *
 * Until L1's bridge is on `window.junto` nothing is offered: the source
 * answers empty, and tests install their own.
 */
import { useEffect, useRef, useState } from "react";
import type { ArtifactLinkRef, LinkedFromBody } from "@shared/artifact-links";
import { mentionLinksOf } from "@shared/mention";
import { getJuntoApi } from "./junto-api";

export type ArtifactTarget = ArtifactLinkRef;
export type BodyLink = LinkedFromBody;

/**
 * A body's line as a reader sees it: each link shows its label, as the
 * document draws it. A link the line bound cut through keeps the label it got.
 */
export const readableLine = (line: string): string => {
  let shown = "";
  let at = 0;
  for (const link of mentionLinksOf(line)) {
    shown += line.slice(at, link.start) + link.label;
    at = link.end;
  }
  shown += line.slice(at);
  return shown.replace(/\[([^\]\n]*)\]\([^)\s]*$/u, "$1…").trim();
};

export type BodyLinksSource = {
  readonly linkedFrom: (canvasName: string, target: ArtifactTarget) => Promise<ReadonlyArray<BodyLink>>;
  readonly onChanged: (listener: (event: { readonly canvasName: string }) => void) => () => void;
};

const NONE: BodyLinksSource = { linkedFrom: async () => [], onChanged: () => () => undefined };

let installed: BodyLinksSource | null = null;

/** Tests set the source; null goes back to the bridge. */
export const installBodyLinks = (source: BodyLinksSource | null): void => {
  installed = source;
};

const bridged = (): BodyLinksSource | undefined =>
  (getJuntoApi() as { readonly artifactLinks?: BodyLinksSource } | undefined)?.artifactLinks;

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
