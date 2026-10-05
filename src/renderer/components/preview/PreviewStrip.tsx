import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import {
  previewBeforeAfter,
  previewRefsIn,
  type PreviewSource,
} from "@shared/preview";
import { Thumbnail, ThumbnailMore, ThumbnailStrip } from "../ui";
import { PreviewViewer } from "./PreviewViewer";
import { previewTile, usePreviewLoad, usePreviews } from "./use-previews";
import "./preview.css";

/** How many tiles a card shows before the rest fold into one. */
const SHOWN = 4;

/**
 * The files a piece of agent markdown names, as thumbnails that open a
 * viewer. Mount it only where the operator has asked to see the text (a
 * card's open details): mounting is what starts the reads.
 *
 * A path main does not confirm draws nothing here and stays as the text it
 * already is; one that was a file and is gone gets a quiet line saying so.
 */
export function PreviewStrip({ markdown, source }: { readonly markdown: string; readonly source: PreviewSource }) {
  const refs = useMemo(() => previewRefsIn(markdown), [markdown]);
  const load = usePreviewLoad(source);
  const thumbs = usePreviews(load, refs, "thumb");
  const [openAt, setOpenAt] = useState<string | null>(null);

  // A tile for what main confirmed, and for an image still on its way.
  const items = refs.filter((ref) => {
    const result = thumbs.get(ref.path);
    return result === undefined ? ref.kind === "image" : result.ok;
  });
  const gone = refs.filter((ref) => {
    const result = thumbs.get(ref.path);
    return result !== undefined && !result.ok && result.reason === "missing";
  });
  if (items.length === 0 && gone.length === 0) return null;

  const pair = previewBeforeAfter(items);
  const shown = items.length > SHOWN + 1 ? items.slice(0, SHOWN) : items;
  const rest = items.length - shown.length;

  return (
    <div className="preview-strip" data-testid="preview-strip">
      {items.length > 0 ? (
        <ThumbnailStrip label="Files in these details">
          {shown.map((ref) => {
            const tile = previewTile(ref, thumbs.get(ref.path));
            return (
              <Thumbnail
                key={ref.path}
                size="md"
                state={tile.state}
                src={tile.src}
                extension={tile.extension}
                glyph={tile.text ? <FileText size={16} aria-hidden /> : undefined}
                label={ref.name}
                tag={pair?.[0] === ref ? "A" : pair?.[1] === ref ? "B" : undefined}
                data-testid="preview-thumbnail"
                onClick={() => setOpenAt(ref.path)}
              />
            );
          })}
          {rest > 0 ? (
            <ThumbnailMore size="md" count={rest} title={`${rest} more`} onClick={() => setOpenAt(items[SHOWN]!.path)} />
          ) : null}
        </ThumbnailStrip>
      ) : null}
      {gone.map((ref) => (
        <p key={ref.path} className="preview-strip__gone" title={ref.path}>
          {ref.name}, file not found
        </p>
      ))}
      {openAt !== null && items.some((ref) => ref.path === openAt) ? (
        <PreviewViewer
          items={items}
          thumbs={thumbs}
          load={load}
          source={source}
          startAt={openAt}
          onClose={() => setOpenAt(null)}
        />
      ) : null}
    </div>
  );
}
