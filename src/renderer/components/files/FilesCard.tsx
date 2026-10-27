import { useEffect, useRef, useState, type DragEvent } from "react";
import type { NodeOf } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { ROOT_PATH } from "@shared/files";
import { useFeatureOn } from "../../lib/experimental-features";
import { CARD_DROP_NOTICE_MS, cardDropNotice, type CardDropNotice } from "../../lib/files-card";
import { hasFinderFiles } from "../../lib/files-drop";
import { filesErrorLine, filesSource } from "../../lib/files-source";
import { onThisMachine } from "../../lib/machines";
import { editText } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { KindCard } from "../nodes/SpineCard";
import "./files-card.css";

type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
};

/**
 * A Files node on the canvas: its name (the operator's label, else the
 * folder's own name, worked out from the root here and never stored) and its
 * folder. Finder files dropped on it copy into the root. The file count joins
 * the line once the Files service answers one.
 */
export function FilesCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: NodeOf<"files">;
} & SinkRenameProps) {
  const name = titleOf(node);
  const takesDrops = useFeatureOn("files") && onThisMachine(node.host);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<CardDropNotice | undefined>();
  const depth = useRef(0);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), CARD_DROP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const finderDrag = (event: DragEvent<HTMLElement>): boolean => {
    if (!takesDrops || !hasFinderFiles(event.dataTransfer?.types)) return false;
    // The canvas below places dropped images; a drop on this card is the card's.
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const drop = async (files: ReadonlyArray<File>) => {
    const source = filesSource();
    const sources = files.map((file) => source.pathForDroppedFile(file)).filter((path) => path.length > 0);
    const outcome =
      sources.length === 0
        ? undefined
        : await source.import({ canvas: state$.canvasName.peek(), node: node.id }, ROOT_PATH, sources);
    setNotice(cardDropNotice(sources, outcome, name, filesErrorLine));
  };

  const line = notice?.text ?? node.root;

  return (
    <div
      className="files-card h-full w-full"
      data-testid="files-card"
      data-drop={over ? "true" : undefined}
      data-notice={notice === undefined ? undefined : notice.failed ? "failed" : "done"}
      onDragEnter={(event) => {
        if (!finderDrag(event)) return;
        depth.current += 1;
        setOver(true);
        setNotice(undefined);
      }}
      onDragOver={(event) => {
        if (!finderDrag(event)) return;
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!finderDrag(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!finderDrag(event)) return;
        depth.current = 0;
        setOver(false);
        void drop([...event.dataTransfer.files]);
      }}
    >
      <KindCard
        kind="files"
        name={name}
        status={notice?.failed ? "off" : undefined}
        nameEditor={
          renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={node.label ?? ""}
              ariaLabel="Rename files"
              onCommit={(next) => editText(node.id, next)}
              onDone={onRenameDone}
            />
          ) : undefined
        }
        line={line}
        lineTitle={line}
      />
    </div>
  );
}
