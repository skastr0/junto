import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FileBox,
  FileText,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import type { ContentRef } from "@shared/content";
import {
  CONTENT_REASON_HEADER,
  CONTENT_STATE_HEADER,
  contentMediaKind,
  contentObjectUrl,
} from "@shared/content-url";
import { Button } from "../ui/Button";
import "./content-media.css";

export type ContentMediaStatus =
  | "loading"
  | "ready"
  | "missing"
  | "corrupt"
  | "unavailable"
  | "error";

type ContentMediaProps = {
  readonly contentRef: ContentRef;
  readonly alt?: string;
  readonly className?: string;
  readonly controls?: boolean;
  /**
   * Canvas / note chrome: image fills the parent, no media-type caption or
   * ledger padding. Work ledger keeps the default (false).
   */
  readonly bare?: boolean;
};

const formatBytes = (count: number): string => `${count.toLocaleString()} bytes`;

const stateLabel = (status: ContentMediaStatus): string => {
  switch (status) {
    case "loading":
      return "Loading content…";
    case "missing":
      return "Content missing";
    case "corrupt":
      return "Content corrupt";
    case "unavailable":
      return "Content unavailable";
    case "error":
      return "Content failed to load";
    case "ready":
      return "Ready";
  }
};

/** Media types we can stream into a readable text preview in the ledger. */
const isTextLikeMediaType = (mediaType: string): boolean => {
  const top = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (top.startsWith("text/")) return true;
  return (
    top === "application/json" ||
    top === "application/ld+json" ||
    top === "application/xml" ||
    top === "application/javascript" ||
    top === "application/typescript" ||
    top === "application/x-yaml" ||
    top === "application/yaml" ||
    top === "application/markdown" ||
    top === "application/x-md" ||
    top.endsWith("+json") ||
    top.endsWith("+xml")
  );
};

/**
 * Open a content stream: download via blob (vellum-content:// anchors with
 * download= do not work reliably in Electron).
 */
const openContentStream = async (
  url: string,
  filename: string,
): Promise<void> => {
  const response = await fetch(url);
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Keep the blob URL long enough for the download to start.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
};

/**
 * Renders a ContentRef via the app-owned content protocol. Never builds a
 * Base64 data URL. Probes HEAD first for explicit missing/corrupt states, then
 * binds img/audio/video to the stream URL so range seeks stay in main.
 */
export function ContentMedia({
  contentRef,
  alt,
  className,
  controls = true,
  bare = false,
}: ContentMediaProps) {
  const url = contentObjectUrl(contentRef);
  const kind = contentMediaKind(contentRef.mediaType);
  const label =
    contentRef.displayName ??
    alt ??
    contentRef.mediaType;
  const downloadName =
    contentRef.displayName?.trim() ||
    `${contentRef.sha256.slice(0, 12)}.bin`;
  const [status, setStatus] = useState<ContentMediaStatus>("loading");
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [retryToken, setRetryToken] = useState(0);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const shellClass = [
    "content-media",
    bare ? "content-media--bare" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const probe = useCallback(async () => {
    setStatus("loading");
    setReason(undefined);
    setTextPreview(null);
    setTextError(null);
    setOpenError(null);
    const elementBacked =
      kind === "image" || kind === "audio" || kind === "video";
    try {
      const response = await fetch(url, { method: "HEAD" });
      const headerState = response.headers.get(CONTENT_STATE_HEADER);
      const headerReason =
        response.headers.get(CONTENT_REASON_HEADER) ?? undefined;
      if (response.ok || response.status === 206) {
        setStatus("ready");
        setReason(undefined);
        return;
      }
      if (
        headerState === "missing" ||
        headerState === "corrupt" ||
        headerState === "unavailable"
      ) {
        setStatus(headerState);
        setReason(headerReason);
        return;
      }
      // Explicit non-OK without a known state: still try the media element —
      // it uses a separate load path and can succeed when fetch is limited.
      if (elementBacked) {
        setStatus("ready");
        setReason(headerReason ?? `HTTP ${response.status}`);
        return;
      }
      setStatus("error");
      setReason(headerReason ?? `HTTP ${response.status}`);
    } catch (error) {
      // Network / CORS / protocol races: element-backed kinds fall through to
      // <img>/<audio>/<video>, which report failure via onError if real.
      if (elementBacked) {
        setStatus("ready");
        setReason(error instanceof Error ? error.message : "fetch failed");
        return;
      }
      setStatus("error");
      setReason(error instanceof Error ? error.message : "fetch failed");
    }
  }, [url, kind]);

  useEffect(() => {
    void probe();
  }, [probe, retryToken]);

  // Text-like binaries: load body for inline preview (research JSON, md, etc.).
  useEffect(() => {
    if (status !== "ready" || kind !== "binary") return;
    if (!isTextLikeMediaType(contentRef.mediaType)) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok && response.status !== 206) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!cancelled) setTextPreview(text);
      } catch (error) {
        if (!cancelled) {
          setTextError(error instanceof Error ? error.message : "decode failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, kind, url, contentRef.mediaType]);

  const handleOpen = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      await openContentStream(url, downloadName);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "open failed");
    } finally {
      setOpening(false);
    }
  }, [url, downloadName]);

  if (status === "loading") {
    return (
      <div
        className={`${shellClass} content-media--loading`}
        role="status"
        aria-live="polite"
      >
        <LoaderCircle size={16} className="content-media__spin" aria-hidden />
        {bare ? null : (
          <div>
            <strong>{label}</strong>
            <span>{formatBytes(contentRef.byteLength)}</span>
            <small>{stateLabel(status)}</small>
          </div>
        )}
      </div>
    );
  }

  if (status !== "ready") {
    return (
      <div
        className={`${shellClass} content-media--${status}`}
        role="alert"
      >
        <AlertTriangle size={16} aria-hidden />
        {bare ? (
          <span className="content-media__bare-error">{stateLabel(status)}</span>
        ) : (
          <div>
            <strong>{stateLabel(status)}</strong>
            <span>{label}</span>
            <span>{formatBytes(contentRef.byteLength)}</span>
            {reason ? <small>{reason}</small> : null}
          </div>
        )}
        <Button
          size="xs"
          variant="subtle"
          onClick={() => setRetryToken((n) => n + 1)}
        >
          <RotateCcw size={11} />
          Retry
        </Button>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className={`${shellClass} content-media--image`}>
        <img
          src={url}
          alt={label}
          draggable={false}
          onError={() => {
            setStatus("error");
            setReason("image element failed to decode stream");
          }}
        />
        {bare ? null : <span>{contentRef.mediaType}</span>}
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div
        className={`content-media content-media--audio${className ? ` ${className}` : ""}`}
      >
        <audio
          src={url}
          controls={controls}
          preload="metadata"
          onError={() => {
            setStatus("error");
            setReason("audio element failed to load stream");
          }}
        >
          <track kind="captions" />
        </audio>
        <span>{label}</span>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div
        className={`content-media content-media--video${className ? ` ${className}` : ""}`}
      >
        <video
          src={url}
          controls={controls}
          preload="metadata"
          onError={() => {
            setStatus("error");
            setReason("video element failed to load stream");
          }}
        >
          <track kind="captions" />
        </video>
        <span>{label}</span>
      </div>
    );
  }

  // Text-like stream: inline preview + download action.
  if (textPreview !== null) {
    return (
      <div
        className={`content-media content-media--text${className ? ` ${className}` : ""}`}
      >
        <div className="content-media__bar">
          <FileText size={13} aria-hidden />
          <span className="content-media__type">{contentRef.mediaType}</span>
          <span className="content-media__bytes">
            {formatBytes(contentRef.byteLength)}
          </span>
          <Button
            size="xs"
            variant="subtle"
            disabled={opening}
            data-testid="content-media-open"
            onClick={() => void handleOpen()}
          >
            <Download size={11} />
            {opening ? "Opening…" : "Save"}
          </Button>
        </div>
        <pre className="content-media__body">{textPreview}</pre>
        {openError ? (
          <p className="content-media__error" role="alert">
            {openError}
          </p>
        ) : null}
      </div>
    );
  }

  // Binary: whole row opens (download); dedicated Open control works the same.
  return (
    <div
      className={`content-media content-media--binary${className ? ` ${className}` : ""}`}
      data-testid="content-media-binary"
    >
      <button
        type="button"
        className="content-media__row"
        data-testid="content-media-row"
        aria-label={`Open ${label}`}
        disabled={opening}
        onClick={() => void handleOpen()}
      >
        <FileBox size={18} aria-hidden />
        <div className="content-media__meta">
          <strong>{label}</strong>
          <span>{formatBytes(contentRef.byteLength)}</span>
          <small>
            {textError
              ? `Could not preview · ${textError}`
              : isTextLikeMediaType(contentRef.mediaType)
                ? "Loading preview…"
                : contentRef.mediaType}
          </small>
        </div>
        <span className="content-media__open" aria-hidden>
          <ExternalLink size={12} />
          {opening ? "Opening…" : "Open"}
        </span>
      </button>
      {openError ? (
        <p className="content-media__error" role="alert">
          {openError}
        </p>
      ) : null}
    </div>
  );
}
