import { use$ } from "@legendapp/state/react";
import { mentionRefOf, parseMentionHref } from "@shared/mention";
import { state$ } from "../../../lib/state";
import { nodeAt } from "../../../lib/use-model";
import { usePreviewFace } from "../../../lib/use-preview-face";
import { PreviewCard } from "../../embeds/PreviewCard";

/**
 * A Junto thing on the pad: the shared preview card for the mention href an
 * embeddable holds, live from the stores, quiet when the thing is gone.
 */
export function PadCard({ href }: { readonly href: string }) {
  const canvasName = use$(state$.canvasName) || "";
  const target = parseMentionHref(href);
  const ref = target === undefined ? undefined : mentionRefOf(target, (id) => nodeAt(canvasName, id)?.kind);
  const face = usePreviewFace(ref, canvasName, href);
  return (
    <div className="excalidraw-pad__card" data-testid="pad-card">
      <PreviewCard {...face} size="card" />
    </div>
  );
}
