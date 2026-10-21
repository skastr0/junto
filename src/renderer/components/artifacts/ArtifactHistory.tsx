import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { artifactText, type ArtifactVersionRecord } from "@shared/artifact";
import { Button, ListRow, PaneHeader } from "../ui";
import { actorLabel, ageLabel } from "./artifacts-pane-model";

/**
 * Every version of one artifact, newest first. Picking one shows it as the
 * text an agent reads; Restore writes it back as a new version on the head,
 * so history only ever grows.
 */
export function ArtifactHistory({
  versions,
  head,
  now,
  onRestore,
  onClose,
}: {
  readonly versions: ReadonlyArray<ArtifactVersionRecord>;
  readonly head: number;
  readonly now: number;
  readonly onRestore: (record: ArtifactVersionRecord) => void;
  readonly onClose: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const shown = versions.find((record) => record.version === picked) ?? null;
  return (
    <div className="artifact-history">
      <PaneHeader
        eyebrow={`History, ${versions.length} ${versions.length === 1 ? "version" : "versions"}`}
        actions={
          <Button size="sm" variant="subtle" onClick={onClose}>
            Back to editing
          </Button>
        }
      />
      <div className="artifact-history__body">
        <div className="artifact-history__list" role="list" aria-label="Versions">
          {versions.map((record) => (
            <ListRow
              key={record.version}
              leading={<History size={12} aria-hidden />}
              title={`Version ${record.version}${record.version === head ? ", head" : ""}`}
              meta={`${actorLabel(record.author)} ${ageLabel(record.at, now)}`}
              selected={record.version === picked}
              onClick={() => setPicked(record.version)}
            />
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
              <pre className="artifact-history__text">{artifactText(shown.body)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
