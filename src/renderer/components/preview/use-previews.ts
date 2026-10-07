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

const POSTER_EDGE = 480;
const POSTER_WAIT_MS = 8000;

/**
 * One frame of a video, as a picture for its tile. The video is the app's
 * own stream; only its start is read. Undefined when no frame can be drawn
 * (a codec this build does not play): the tile is then a glyph.
 */
const captureVideoPoster = (url: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (poster?: string): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(poster);
    };
    const timer = window.setTimeout(() => finish(), POSTER_WAIT_MS);
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.addEventListener("error", () => finish());
    // A little way in: the very first frame is often black.
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(1, (Number.isFinite(video.duration) ? video.duration : 0) / 4);
    });
    video.addEventListener("seeked", () => {
      try {
        const scale = Math.min(1, POSTER_EDGE / Math.max(video.videoWidth, video.videoHeight, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        finish();
      }
    });
    video.src = url;
  });

/** A video's poster, by its address. Kept for the life of the window: a stream's bytes never change. */
const posters = new Map<string, Promise<string | undefined>>();
const videoPoster = (url: string): Promise<string | undefined> => {
  let poster = posters.get(url);
  if (!poster) {
    poster = captureVideoPoster(url);
    posters.set(url, poster);
  }
  return poster;
};

/** A preview as a tile draws it: main's answer, plus a video's poster once one is drawn here. */
export type PreviewTileResult = PreviewResult & { readonly poster?: string };

/**
 * The previews of these refs, by path, as they arrive. Loading starts in an
 * effect, so it never holds up the paint of whatever mounted it.
 */
export const usePreviews = (
  load: PreviewLoad,
  refs: ReadonlyArray<PreviewRef>,
  variant: "thumb" | "full",
): ReadonlyMap<string, PreviewTileResult> => {
  const [results, setResults] = useState<ReadonlyMap<string, PreviewTileResult>>(() => new Map());
  useEffect(() => {
    let live = true;
    for (const ref of refs) {
      void load(ref, variant).then((result) => {
        if (!live) return;
        setResults((current) => (current.get(ref.path) === result ? current : new Map(current).set(ref.path, result)));
        if (variant !== "thumb" || !result.ok || result.kind !== "video") return;
        void videoPoster(result.url).then((poster) => {
          if (!live || poster === undefined) return;
          setResults((current) => new Map(current).set(ref.path, { ...result, poster }));
        });
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
  result: PreviewTileResult | undefined,
): {
  readonly state: ThumbnailState;
  readonly src?: string;
  readonly extension?: string;
  readonly text: boolean;
  readonly video: boolean;
} => {
  if (result === undefined) return { state: "loading", text: false, video: false };
  if (!result.ok) return { state: "failed", text: false, video: false };
  if (result.kind === "image") return { state: "ready", src: result.dataUrl, text: false, video: false };
  if (result.kind === "video") {
    return { state: "ready", src: result.poster, extension: previewExtension(`/${result.name}`), text: false, video: true };
  }
  return {
    state: "ready",
    extension: result.kind === "file" ? result.extension : previewExtension(ref.path),
    text: result.kind === "text",
    video: false,
  };
};
