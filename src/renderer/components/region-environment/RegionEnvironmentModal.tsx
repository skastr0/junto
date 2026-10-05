import { useMemo } from "react";
import { X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { ulid } from "ulid";
import { setRegionEnvironment } from "../../lib/mutations";
import { regionEnvironmentPort } from "../../lib/region-environment-port";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, OverlayHeader } from "../ui";
import { RegionEnvironmentScreen } from "./RegionEnvironmentScreen";

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
  const node = use$(() => state$.doc.nodes.get().find((n) => n.id === nodeId));
  const port = useMemo(() => regionEnvironmentPort(), []);
  if (!node || node.type !== "group") return null;
  const environment = node.ether?.region?.environment;
  const label = node.label?.trim() || "this region";
  return (
    <FocusSurface measure="document" height="fit" label="Region environment" onClose={onClose}>
      <div className="region-env-modal">
        <OverlayHeader
          eyebrow="region"
          title="Environment"
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
