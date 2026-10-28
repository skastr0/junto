import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { artifactText, type ArtifactVersionRecord } from "@shared/artifact";
import { Button, ListRow } from "../ui";
import { actorLabel, ageLabel } from "./artifacts-pane-model";
import { DocumentEditor } from "./lazy-editors";

/** A past version takes no writes. */
const refuseWrite = async (): Promise<string | null> => "An old version cannot be edited. Restore it first.";

/**
 * Every version of one artifact, newest first. Picking one shows it: a
 * document rendered as it reads, with no caret, anything else as the text an
 * agent reads. Restore writes it back as a new version on the head, so
 * history only ever grows.
 */
export function ArtifactHistory({
  versions,
  head,
  now,
  onRestore,
}: {
  readonly versions: ReadonlyArray<ArtifactVersionRecord>;
  readonly head: number;
  readonly now: number;
  readonly onRestore: (record: ArtifactVersionRecord) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const shown = versions.find((record) => record.version === picked) ?? null;
  return (
    <div className="artifact-history">
      <div className="artifact-history__body">
        <div className="artifact-history__list" role="list" aria-label="Versions">
          {/* A list holds list items only: each row sits in one. */}
          {versions.map((record) => (
            <div role="listitem" key={record.version}>
              <ListRow
                leading={<History size={12} aria-hidden />}
                title={`Version ${record.version}${record.version === head ? ", head" : ""}`}
                meta={`${actorLabel(record.author)} ${ageLabel(record.at, now)}`}
                selected={record.version === picked}
                onClick={() => setPicked(record.version)}
              />
            </div>
          ))}
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
