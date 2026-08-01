import type { ContentRef } from "./content";
import {
  ContentByteLength,
  ContentDisplayName,
  ContentMediaType,
  ContentSha256,
} from "./content";
import { Schema } from "effect";

/**
 * App-owned content object URL for renderer media.
 *
 * Bytes never enter renderer state as Base64. The main process streams from
 * the local content store; the URL carries only ContentRef metadata.
 *
 * Form: `vellum-content://object/<sha256>?byteLength=N&mediaType=...`
 * Optional: `displayName`
 */
export const CONTENT_PROTOCOL_SCHEME = "vellum-content" as const;
export const CONTENT_PROTOCOL_HOST = "object" as const;

export type ContentMediaKind = "image" | "audio" | "video" | "binary";

const SHA256_RE = /^[a-f0-9]{64}$/u;

/** Classify a media type for element selection (img / audio / video / other). */
export const contentMediaKind = (mediaType: string): ContentMediaKind => {
  const top = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (top.startsWith("image/")) return "image";
  if (top.startsWith("audio/")) return "audio";
  if (top.startsWith("video/")) return "video";
  return "binary";
};

/**
 * Build the app-owned URL for a ContentRef. Renderer media elements and fetch
 * use this; filesystem paths never appear.
 */
export const contentObjectUrl = (ref: ContentRef): string => {
  const params = new URLSearchParams();
  params.set("byteLength", String(ref.byteLength));
  params.set("mediaType", ref.mediaType);
  if (ref.displayName !== undefined) {
    params.set("displayName", ref.displayName);
  }
  return `${CONTENT_PROTOCOL_SCHEME}://${CONTENT_PROTOCOL_HOST}/${ref.sha256}?${params.toString()}`;
};

/**
 * Strict parse of a content object URL into a ContentRef. Rejects anything
 * that is not a well-formed, credential-free content URL.
 */
export const parseContentObjectUrl = (url: string): ContentRef | undefined => {
  if (url.includes("\\")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${CONTENT_PROTOCOL_SCHEME}:` ||
    parsed.hostname !== CONTENT_PROTOCOL_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    return undefined;
  }

  const segments = parsed.pathname.replace(/^\/+/u, "").split("/");
  if (segments.length !== 1) return undefined;
  const sha256 = segments[0] ?? "";
  if (!SHA256_RE.test(sha256)) return undefined;

  const byteLengthRaw = parsed.searchParams.get("byteLength");
  const mediaTypeRaw = parsed.searchParams.get("mediaType");
  if (byteLengthRaw === null || mediaTypeRaw === null) return undefined;
  if (parsed.searchParams.get("path") !== null) return undefined;

  const byteLength = Number(byteLengthRaw);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;

  const displayNameRaw = parsed.searchParams.get("displayName");

  try {
    return Schema.decodeUnknownSync(
      Schema.Struct({
        sha256: ContentSha256,
        byteLength: ContentByteLength,
        mediaType: ContentMediaType,
        displayName: Schema.optionalWith(ContentDisplayName, { exact: true }),
      }),
      { onExcessProperty: "error" },
    )({
      sha256,
      byteLength,
      mediaType: mediaTypeRaw,
      ...(displayNameRaw !== null && displayNameRaw.length > 0
        ? { displayName: displayNameRaw }
        : {}),
    });
  } catch {
    return undefined;
  }
};

/** Response header names used by the content protocol (stable for renderer UX). */
export const CONTENT_STATE_HEADER = "X-Vellumcommand-Content-State" as const;
export const CONTENT_REASON_HEADER = "X-Vellumcommand-Content-Reason" as const;
export const CONTENT_SHA256_HEADER = "X-Vellumcommand-Content-Sha256" as const;
