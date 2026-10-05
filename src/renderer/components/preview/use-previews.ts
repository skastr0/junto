import { useEffect, useMemo, useState } from "react";
import {
  previewExtension,
  previewTargetOf,
  type PreviewRef,
  type PreviewResult,
  type PreviewSource,
} from "@shared/preview";
import type { ThumbnailState } from "../ui";
import { getJuntoApi } from "../../lib/junto-api";

/** Fetch one preview. The only way a preview component reaches main. */
export type PreviewLoad = (ref: PreviewRef, variant: "thumb" | "full") => Promise<PreviewResult>;

const UNAVAILABLE: PreviewResult = { ok: false, reason: "not-named" };

/**
 * The loader for one source, with a cache that lives as long as the caller
 * is mounted: a file is read once per variant while its card is open, and
 * read again the next time, since an agent may have rewritten it.
 */
export const usePreviewLoad = (source: PreviewSource): PreviewLoad => {
  const signalId = source.signalId;
  return useMemo(() => {
    const cache = new Map<string, Promise<PreviewResult>>();
    return (ref, variant) => {
      const key = `${variant}\n${ref.path}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const api = getJuntoApi();
      const pending: Promise<PreviewResult> = api?.previewRead
        ? api.previewRead({ source: { kind: "signal", signalId }, target: previewTargetOf(ref), variant }).catch(() => UNAVAILABLE)
        : Promise.resolve(UNAVAILABLE);
      cache.set(key, pending);
      return pending;
    };
  }, [signalId]);
};

/**
 * The previews of these refs, by path, as they arrive. Loading starts in an
 * effect, so it never holds up the paint of whatever mounted it.
 */
export const usePreviews = (
  load: PreviewLoad,
  refs: ReadonlyArray<PreviewRef>,
  variant: "thumb" | "full",
): ReadonlyMap<string, PreviewResult> => {
  const [results, setResults] = useState<ReadonlyMap<string, PreviewResult>>(() => new Map());
  useEffect(() => {
    let live = true;
    for (const ref of refs) {
      void load(ref, variant).then((result) => {
        if (!live) return;
        setResults((current) => (current.get(ref.path) === result ? current : new Map(current).set(ref.path, result)));
      });
    }
    return () => {
      live = false;
    };
  }, [load, refs, variant]);
  return results;
};

export const formatPreviewBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** What a tile draws for a ref, from what main said about it so far. */
export const previewTile = (
  ref: PreviewRef,
  result: PreviewResult | undefined,
): { readonly state: ThumbnailState; readonly src?: string; readonly extension?: string; readonly text: boolean } => {
  if (result === undefined) return { state: "loading", text: false };
  if (!result.ok) return { state: "failed", text: false };
  if (result.kind === "image") return { state: "ready", src: result.dataUrl, text: false };
  return {
    state: "ready",
    extension: result.kind === "file" ? result.extension : previewExtension(ref.path),
    text: result.kind === "text",
  };
};
