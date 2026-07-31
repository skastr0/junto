import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileBox, LoaderCircle, RotateCcw } from "lucide-react";
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
}: ContentMediaProps) {
  const url = contentObjectUrl(contentRef);
  const kind = contentMediaKind(contentRef.mediaType);
  const label =
    contentRef.displayName ??
    alt ??
    contentRef.mediaType;
  const [status, setStatus] = useState<ContentMediaStatus>("loading");
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [retryToken, setRetryToken] = useState(0);

  const probe = useCallback(async () => {
    setStatus("loading");
    setReason(undefined);
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
      setStatus("error");
      setReason(headerReason ?? `HTTP ${response.status}`);
    } catch (error) {
      setStatus("error");
      setReason(error instanceof Error ? error.message : "fetch failed");
    }
  }, [url]);

  useEffect(() => {
    void probe();
  }, [probe, retryToken]);

  if (status === "loading") {
    return (
      <div
        className={`content-media content-media--loading${className ? ` ${className}` : ""}`}
        role="status"
        aria-live="polite"
      >
        <LoaderCircle size={16} className="content-media__spin" aria-hidden />
        <div>
          <strong>{label}</strong>
          <span>{formatBytes(contentRef.byteLength)}</span>
          <small>{stateLabel(status)}</small>
        </div>
      </div>
    );
  }

  if (status !== "ready") {
    return (
      <div
        className={`content-media content-media--${status}${className ? ` ${className}` : ""}`}
        role="alert"
      >
        <AlertTriangle size={16} aria-hidden />
        <div>
          <strong>{stateLabel(status)}</strong>
          <span>{label}</span>
          <span>{formatBytes(contentRef.byteLength)}</span>
          {reason ? <small>{reason}</small> : null}
        </div>
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
      <div
        className={`content-media content-media--image${className ? ` ${className}` : ""}`}
      >
        <img
          src={url}
          alt={label}
          onError={() => {
            setStatus("error");
            setReason("image element failed to decode stream");
          }}
        />
        <span>{contentRef.mediaType}</span>
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

  return (
    <div
      className={`content-media content-media--binary${className ? ` ${className}` : ""}`}
    >
      <FileBox size={18} aria-hidden />
      <div>
        <strong>{label}</strong>
        <span>{formatBytes(contentRef.byteLength)}</span>
        <small>Binary content (stream ready)</small>
      </div>
      <a href={url} download={contentRef.displayName ?? contentRef.sha256.slice(0, 12)}>
        Open
      </a>
    </div>
  );
}
