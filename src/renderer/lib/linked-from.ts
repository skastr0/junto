/**
 * Body backlinks, read (0.11 artifact links, L4): the artifacts whose body
 * links to an artifact, newest first, from main's `work_artifact_links`
 * (L1, product-feed). Mail and comments stay with `useMentionedIn`.
 *
 * Until L1's bridge is on `window.junto` nothing is offered: the source
 * answers empty, and tests install their own.
 */
import { useEffect, useRef, useState } from "react";
import type { ArtifactType } from "@shared/artifact";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/resource-command";
import { getJuntoApi } from "./junto-api";

export type ArtifactTarget = { readonly nodeId: NodeId; readonly artifactId: ItemId };

/** One artifact whose head body links to the target. */
export type BodyLink = {
  readonly source: ArtifactTarget;
  /** The source's title now. */
  readonly title: string;
  readonly type: ArtifactType;
  /** The line of text the link sits in, plain. */
  readonly line: string;
  /** Epoch ms of the source's head version. */
  readonly at: number;
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
