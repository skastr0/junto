import { useMemo } from "react";
import { X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { ulid } from "ulid";
import { getJuntoApi } from "../../lib/junto-api";
import { flushPendingCanvasSave, setRegionEnvironment } from "../../lib/mutations";
import { regionEnvironmentPort } from "../../lib/region-environment-port";
import { restartSeatOnSameSession } from "../../lib/seat-relaunch";
import { nodeAt, useNodeOf } from "../../lib/use-model";
import { titleOf } from "@shared/model/title";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, OverlayHeader } from "../ui";
import type { ReadDirectory } from "./PathBrowser";
import { RegionEnvironmentScreen } from "./RegionEnvironmentScreen";

/** The same listing the folder paths control browses, on this machine. */
const readLocalDirectory: ReadDirectory = async (path) => {
  const api = getJuntoApi();
  if (!api?.hostDirectoryRead) throw new Error("host directory listing is unavailable");
  return api.hostDirectoryRead(LOCAL_HOST_ID, path);
};

/**
 * Region settings, environment: the one screen for what the seats inside a
 * region get in their environment. Reads the region off the canvas and writes
 * every edit back at once; the screen itself never touches the document.
 */
export function RegionEnvironmentModal({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const node = useNodeOf(use$(state$.canvasName), nodeId, "region");
  const port = useMemo(
    () =>
      regionEnvironmentPort({
        canvasName: () => state$.canvasName.peek(),
        flushSave: flushPendingCanvasSave,
        findNode: (id) => nodeAt(state$.canvasName.peek(), id),
        restartSeat: restartSeatOnSameSession,
      }),
    [],
  );
  if (!node) return null;
  const environment = node.environment;
  const label = node.label?.trim() || "this region";
  return (
    <FocusSurface measure="document" height="fit" label="Region environment" onClose={onClose}>
      <div className="region-env-modal">
        <OverlayHeader
          eyebrow="region"
          title="Environment and secrets"
          status={`What seats inside ${label} get when they start`}
          actions={
            <IconButton aria-label="Close environment" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />
        <RegionEnvironmentScreen
          regionId={nodeId}
          environment={environment}
          port={port}
          newId={ulid}
          readDirectory={readLocalDirectory}
          seatName={(seatId) => {
            const seat = nodeAt(state$.canvasName.peek(), seatId);
            return seat?.kind === "agent" ? titleOf(seat) : undefined;
          }}
          onChange={(next) => setRegionEnvironment(nodeId, next)}
        />
        <footer className="region-env-modal__footer">
          <Button type="button" size="sm" variant="primary" onClick={onClose}>
            done
          </Button>
        </footer>
      </div>
    </FocusSurface>
  );
}
