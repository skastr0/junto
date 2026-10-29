import { useState } from "react";
import { FolderInput, History, RotateCcw } from "lucide-react";
import { artifactText, type ArtifactVersionRecord } from "@shared/artifact";
import type { ArtifactMoveRecord } from "@shared/artifact-move";
import { Button, ListRow } from "../ui";
import { actorLabel, ageLabel } from "./artifacts-pane-model";
import { DocumentEditor } from "./lazy-editors";

/** A past version takes no writes. */
const refuseWrite = async (): Promise<string | null> => "An old version cannot be edited. Restore it first.";

/**
 * Every version of one artifact, newest first. Picking one shows it: a
 * document rendered as it reads, with no caret, anything else as the text an
 * agent reads. Restore writes it back as a new version on the head, so
 * history only ever grows. A move to another Artifacts node is a line among
 * them at its time (0.11.1, 10): it names the two nodes and who moved it, and
 * is read, not opened.
 */
export function ArtifactHistory({
  versions,
  moves = [],
  moveTitle,
  head,
  now,
  onRestore,
}: {
  readonly versions: ReadonlyArray<ArtifactVersionRecord>;
  /** Every move, oldest first. */
  readonly moves?: ReadonlyArray<ArtifactMoveRecord>;
  /** A move's line: "Moved from Specs to Release". */
  readonly moveTitle?: (move: ArtifactMoveRecord) => string;
  readonly head: number;
  readonly now: number;
  readonly onRestore: (record: ArtifactVersionRecord) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const shown = versions.find((record) => record.version === picked) ?? null;
  // Newest first, a move among the versions at its time; past the oldest version held, only moves after it show.
  const oldest = versions.length === 0 ? -Infinity : Math.min(...versions.map((record) => record.at));
  const rows = [
    ...versions.map((record) => ({ at: record.at, record }) as const),
    ...moves.filter((move) => move.at >= oldest || versions.length === 0).map((move) => ({ at: move.at, move }) as const),
  ].sort((a, b) => b.at - a.at);
  return (
    <div className="artifact-history">
      <div className="artifact-history__body">
        <div className="artifact-history__list" role="list" aria-label="Versions">
          {/* A list holds list items only: each row sits in one. */}
          {rows.map((row) =>
            "record" in row ? (
              <div role="listitem" key={`v${row.record.version}`}>
                <ListRow
                  leading={<History size={12} aria-hidden />}
                  title={`Version ${row.record.version}${row.record.version === head ? ", head" : ""}`}
                  meta={`${actorLabel(row.record.author)} ${ageLabel(row.record.at, now)}`}
                  selected={row.record.version === picked}
                  onClick={() => setPicked(row.record.version)}
                />
              </div>
            ) : (
              <div role="listitem" key={`m${row.move.at}${row.move.to}`}>
                <ListRow
                  leading={<FolderInput size={12} aria-hidden />}
                  title={moveTitle?.(row.move) ?? "Moved to another node"}
                  meta={`${actorLabel(row.move.by)} ${ageLabel(row.move.at, now)}`}
                />
              </div>
            ),
          )}
        </div>
        <div className="artifact-history__view">
          {shown === null ? (
            <p className="artifact-history__hint">Pick a version to read it.</p>
          ) : (
            <>
              <div className="artifact-history__actions">
                <Button
                  size="sm"
                  variant="chrome"
                  disabled={shown.version === head}
                  onClick={() => onRestore(shown)}
                >
                  <RotateCcw size={13} aria-hidden />
                  Restore as version {head + 1}
                </Button>
              </div>
              {shown.body.type === "document" ? (
                <DocumentEditor
                  key={shown.version}
                  body={shown.body}
                  version={shown.version}
                  readOnly
                  onPatch={refuseWrite}
                />
              ) : (
                <pre className="artifact-history__text">{artifactText(shown.body)}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
