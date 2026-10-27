import { useEffect, useRef, useState, type DragEvent } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeOf } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { ROOT_PATH, type FilesCount, type FilesResult } from "@shared/files";
import { useFeatureOn } from "../../lib/experimental-features";
import { CARD_DROP_NOTICE_MS, cardDropNotice, countLine, type CardDropNotice } from "../../lib/files-card";
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
 * The Files service's count for a node on this machine: asked on mount, again
 * when the node's folder changes while a window serves it (a save, a
 * checkout), and on `recount` (a drop on the card, which no window may be
 * serving). The count opens no session. A newer answer always wins.
 */
const useFilesCount = (
  canvas: string,
  node: NodeOf<"files">,
  ask: boolean,
): { readonly count: FilesResult<FilesCount> | undefined; readonly recount: () => void } => {
  const [count, setCount] = useState<FilesResult<FilesCount> | undefined>();
  const recountRef = useRef<() => void>(() => undefined);
  const { id, root } = node;
  useEffect(() => {
    setCount(undefined);
    recountRef.current = () => undefined;
    if (!ask) return;
    const source = filesSource();
    let live = true;
    let asked = 0;
    const recount = () => {
      const seq = ++asked;
      void source.count({ canvas, node: id })
        .then((result) => {
          if (live && seq === asked) setCount(result);
        })
        .catch(() => undefined);
    };
    recountRef.current = recount;
    recount();
    const stop = source.onChange((event) => {
      if (event.node === id && (event.kind === "paths" || event.kind === "reset")) recount();
    });
    return () => {
      live = false;
      stop();
    };
  }, [ask, canvas, id, root]);
  return { count, recount: () => recountRef.current() };
};

/**
 * A Files node on the canvas: its name (the operator's label, else the
 * folder's own name, worked out from the root here and never stored) and how
 * many files are under it, else the folder itself until that is counted or
 * when the count is refused. Finder files dropped on it copy into the root.
 */
export function FilesCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: NodeOf<"files">;
} & SinkRenameProps) {
  const name = titleOf(node);
  const here = onThisMachine(node.host);
  const takesDrops = useFeatureOn("files") && here;
  const counted = useFilesCount(use$(state$.canvasName) || "", node, here);
  const count = countLine(counted.count);
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
    if (outcome?.ok === true) counted.recount();
  };

  const line = notice?.text ?? count ?? node.root;

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
        lineTitle={notice?.full ?? node.root}
      />
    </div>
  );
}
