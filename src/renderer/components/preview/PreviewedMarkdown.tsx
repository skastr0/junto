import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { FileText, Film } from "lucide-react";
import {
  previewBeforeAfter,
  previewLinkedMarkdown,
  previewLinkIndex,
  previewRefsIn,
  previewRefsOfAttachments,
  previewTextFace,
  type PreviewRef,
  type PreviewResult,
  type PreviewSource,
} from "@shared/preview";
import { Thumbnail, ThumbnailMore, ThumbnailStrip } from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { PreviewBlock, type PreviewSeat } from "./PreviewBlock";
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
 *
 * What is read rather than looked at (a diff, a code block, a compare, a
 * commit) is drawn in place under the tiles, each under its caption and
 * name, which open it large.
 */
const readInPlace = (ref: PreviewRef, result: PreviewResult | undefined): boolean => {
  if (result?.ok !== true) return false;
  if (result.kind === "compare" || result.kind === "commit") return true;
  if (result.kind !== "text" || result.format === "markdown") return false;
  const face = previewTextFace(ref.name);
  return face === "diff" || face === "code";
};

export function PreviewedMarkdown({
  markdown,
  attachments,
  source,
  seat,
  onReviewCommit,
  textClassName,
}: {
  /** The agent's text. Absent when the source has only attached files. */
  readonly markdown?: string;
  /**
   * Files the agent attached, shown first and in its order. They are read
   * from the app's own store, so they are there even when the folder they
   * came from is gone.
   */
  readonly attachments?: Parameters<typeof previewRefsOfAttachments>[0];
  readonly source: PreviewSource;
  /** The seat the card came from: what a commit is read against. */
  readonly seat?: PreviewSeat | undefined;
  /** Open the full review of a commit. Given only where the card can be left for it. */
  readonly onReviewCommit?: ((sha: string) => void) | undefined;
  /** The caller's own box around the text. */
  readonly textClassName?: string;
}) {
  const named = useMemo(() => (markdown === undefined ? [] : previewRefsIn(markdown)), [markdown]);
  const refs = useMemo(
    () => [...previewRefsOfAttachments(attachments ?? []), ...named],
    [attachments, named],
  );
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
    // A loose ref may never have been a path: say nothing about it.
    return !ref.loose && result !== undefined && !result.ok && result.reason === "missing";
  });
  const text = useMemo(
    () =>
      markdown === undefined
        ? undefined
        : previewLinkedMarkdown(
            markdown,
            new Set(named.filter((ref) => thumbs.get(ref.path)?.ok === true).map((ref) => ref.path)),
          ),
    [markdown, named, thumbs],
  );
  // A file name in the text opens the viewer at that file.
  const onTextClick = (event: MouseEvent<HTMLDivElement>): void => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const index = previewLinkIndex(link?.getAttribute("href"));
    if (index === undefined) return;
    event.preventDefault();
    // A link's number is its place among the paths the text names.
    const ref = named[index];
    if (ref) setOpenAt(ref.path);
  };

  // Enter on a thumbnail or a file name presses it. A surface around this
  // one may use Enter for something else (the feed writes a reply): it must
  // not hear it from here.
  const keepEnter = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" || !(event.target instanceof Element)) return;
    const control = event.target.closest("button, a");
    if (!control) return;
    if (control instanceof HTMLAnchorElement && previewLinkIndex(control.getAttribute("href")) === undefined) return;
    event.stopPropagation();
  };

  const pair = previewBeforeAfter(items);
  const blocks = items.filter((ref) => readInPlace(ref, thumbs.get(ref.path)));
  const tiles = items.filter((ref) => !blocks.includes(ref));
  const shown = tiles.length > SHOWN + 1 ? tiles.slice(0, SHOWN) : tiles;
  const rest = tiles.length - shown.length;

  return (
    <>
      {text !== undefined ? (
        <div className={textClassName} onClick={onTextClick} onKeyDown={keepEnter}>
          <ArtifactMarkdown source={text} />
        </div>
      ) : null}
      {items.length > 0 || gone.length > 0 ? (
        <div className="preview-strip" data-testid="preview-strip" onKeyDown={keepEnter}>
          {tiles.length > 0 ? (
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
                    glyph={tile.text ? <FileText size={16} aria-hidden /> : tile.video ? <Film size={16} aria-hidden /> : undefined}
                    playable={tile.video}
                    // An attachment's caption is all that tells two files apart by ear.
                    label={ref.attachment !== undefined && ref.caption ? `${ref.caption}, ${ref.name}` : ref.name}
                    tag={pair?.[0] === ref ? "A" : pair?.[1] === ref ? "B" : undefined}
                    data-testid="preview-thumbnail"
                    onClick={() => setOpenAt(ref.path)}
                  />
                );
              })}
              {rest > 0 ? (
                <ThumbnailMore size="md" count={rest} onClick={() => setOpenAt(tiles[SHOWN]!.path)} />
              ) : null}
            </ThumbnailStrip>
          ) : null}
          {blocks.map((ref) => (
            <section key={ref.path} className="preview-block" data-testid="preview-block" aria-label={ref.caption ?? ref.name}>
              <button type="button" className="preview-block__open" title="Open large" onClick={() => setOpenAt(ref.path)}>
                {ref.caption ? <span className="preview-block__caption">{ref.caption}</span> : null}
                <span className="preview-block__name">{ref.name}</span>
              </button>
              <div className="preview-block__body" tabIndex={0}>
                <PreviewBlock item={ref} result={thumbs.get(ref.path)!} layout="card" seat={seat} onReviewCommit={onReviewCommit} />
              </div>
            </section>
          ))}
          {gone.map((ref) => (
            <p key={ref.path} className="preview-strip__gone" title={ref.attachment === undefined ? ref.path : undefined}>
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
          seat={seat}
          onReviewCommit={onReviewCommit}
          startAt={openAt}
          onClose={() => setOpenAt(null)}
        />
      ) : null}
    </>
  );
}
