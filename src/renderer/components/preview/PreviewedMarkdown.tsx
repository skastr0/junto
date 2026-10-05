import { useMemo, useState, type MouseEvent } from "react";
import { FileText } from "lucide-react";
import {
  previewBeforeAfter,
  previewLinkedMarkdown,
  previewLinkIndex,
  previewRefsIn,
  type PreviewSource,
} from "@shared/preview";
import { Thumbnail, ThumbnailMore, ThumbnailStrip } from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { PreviewViewer } from "./PreviewViewer";
import { previewTile, usePreviewLoad, usePreviews } from "./use-previews";
import "./preview.css";

/** How many tiles a card shows before the rest fold into one. */
const SHOWN = 4;

/**
 * A piece of agent markdown with the files it names: the text, then the
 * files as thumbnails that open a viewer. Mount it only where the operator
 * has asked to see the text (a card's open details): mounting is what starts
 * the reads.
 *
 * Once main confirms a path, the text shows it as its file name, a link that
 * opens the viewer there; the full path is the link's title. A path main
 * does not confirm stays as the agent wrote it, and one that was a file and
 * is gone gets a quiet line saying so.
 */
export function PreviewedMarkdown({
  markdown,
  source,
  textClassName,
}: {
  readonly markdown: string;
  readonly source: PreviewSource;
  /** The caller's own box around the text. */
  readonly textClassName?: string;
}) {
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
  const text = useMemo(
    () =>
      previewLinkedMarkdown(
        markdown,
        new Set(refs.filter((ref) => thumbs.get(ref.path)?.ok === true).map((ref) => ref.path)),
      ),
    [markdown, refs, thumbs],
  );
  // A file name in the text opens the viewer at that file.
  const onTextClick = (event: MouseEvent<HTMLDivElement>): void => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const index = previewLinkIndex(link?.getAttribute("href"));
    if (index === undefined) return;
    event.preventDefault();
    const ref = refs[index];
    if (ref) setOpenAt(ref.path);
  };

  const pair = previewBeforeAfter(items);
  const shown = items.length > SHOWN + 1 ? items.slice(0, SHOWN) : items;
  const rest = items.length - shown.length;

  return (
    <>
      <div className={textClassName} onClick={onTextClick}>
        <ArtifactMarkdown source={text} />
      </div>
      {items.length > 0 || gone.length > 0 ? (
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
        </div>
      ) : null}
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
    </>
  );
}
