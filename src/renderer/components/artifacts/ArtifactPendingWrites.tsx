import type { ArtifactPendingWrite } from "../../lib/artifacts-source";
import { opLabel, pendingWriteLine } from "./artifacts-pane-model";

/**
 * This machine's writes to the artifact that the editing machine has not
 * ruled yet (02 read-your-writes): dashed while they would apply, with the
 * reason when they are at risk. Never another machine's.
 */
export function ArtifactPendingWrites({ writes }: { readonly writes: ReadonlyArray<ArtifactPendingWrite> }) {
  if (writes.length === 0) return null;
  return (
    <ul className="artifact-pending" aria-label="Your writes not yet ruled">
      {writes.map((write) => {
        const line = pendingWriteLine(write);
        return (
          <li key={write.opId} className="artifact-pending__write" data-tone={line.tone}>
            <span className="artifact-pending__op">{opLabel(write.op)}</span>
            <span className="artifact-pending__state">{line.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
