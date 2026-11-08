import { useState } from "react";
import { Play } from "lucide-react";
import type { PreviewSource } from "@shared/preview";
import { getJuntoApi } from "../../lib/junto-api";
import { Button } from "../ui";

/** An address in two parts, so the host is what the eye lands on. */
const partsOf = (url: string): { readonly origin: string; readonly rest: string } => {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, rest: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { origin: url, rest: "" };
  }
};

/**
 * A video at a web address an agent named. The address is shown whole, and
 * nothing is fetched until the operator presses play. Then the app plays it
 * through an address of its own: main fetches the real one, and refuses to
 * be sent anywhere else.
 */
export function RemoteVideo({
  source,
  index,
  url,
  label,
}: {
  readonly source: PreviewSource;
  /** The attachment's place in the source's list: all main is told. */
  readonly index: number;
  /** Shown, never loaded from here. */
  readonly url: string;
  readonly label: string;
}) {
  const [stream, setStream] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const { origin, rest } = partsOf(url);

  const play = (): void => {
    setFailed(undefined);
    void getJuntoApi()
      ?.previewPlay?.(source, index)
      .then((result) => (result.ok ? setStream(result.url) : setFailed("This video could not be opened.")))
      .catch(() => setFailed("This video could not be opened."));
  };

  if (stream !== undefined && failed === undefined) {
    return (
      <div className="preview-viewer__video" data-testid="preview-video">
        <video
          src={stream}
          controls
          autoPlay
          playsInline
          aria-label={label}
          onError={() => setFailed("The address did not answer with a video the app can play.")}
        />
      </div>
    );
  }
  return (
    <div className="preview-viewer__file" data-testid="preview-link">
      <p className="preview-viewer__address" data-testid="preview-link-address">
        <span className="preview-viewer__address-host">{origin}</span>
        {rest}
      </p>
      <p className="preview-viewer__note">
        {failed ?? "A video at this address, named by the agent. Nothing is fetched until you press play."}
      </p>
      <Button size="sm" variant="chrome" onClick={play}>
        <Play size={12} aria-hidden />
        {failed ? "Try again" : "Play"}
      </Button>
    </div>
  );
}
