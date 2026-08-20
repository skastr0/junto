import { useEffect, useMemo, useState } from "react";
import { Pin } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { regionStack } from "@shared/graph";
import { state$ } from "../../lib/state";
import { pinRuling } from "../../lib/mutations";
import { nodeTitle } from "../../lib/presentation";
import { Button, Select } from "../ui";

// Pin-as-ruling (spec section 6): the answer the operator just gave becomes
// standing precedent on the region holding this sink. Innermost region is the
// default — the closest law to the work. With no containing region there is
// nowhere for a ruling to stand, so the affordance stays silent.

export function PinRulingControl({
  nodeId,
  text,
  sourceRequestId,
}: {
  readonly nodeId: string;
  readonly text: string;
  readonly sourceRequestId?: string;
}) {
  const doc = use$(state$.doc);
  const regions = useMemo(() => regionStack(doc, nodeId), [doc, nodeId]);
  const innermost = regions[regions.length - 1];
  const [regionId, setRegionId] = useState(innermost?.id ?? "");
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    setRegionId(innermost?.id ?? "");
    setPinned(false);
  }, [innermost?.id, nodeId]);

  useEffect(() => {
    setPinned(false);
  }, [text]);

  if (regions.length === 0) return null;
  const target = regions.find((region) => region.id === regionId) ?? innermost;
  if (!target) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Button
        size="xs"
        variant="subtle"
        disabled={!text.trim() || pinned}
        aria-label={`Pin this answer as a ruling on region ${nodeTitle(target)}`}
        title="Seats inside the region read pinned rulings on onboard"
        onClick={() => {
          pinRuling(target.id, text, sourceRequestId);
          setPinned(true);
        }}
      >
        <Pin size={11} />
        {pinned ? "pinned" : "pin as ruling"}
      </Button>
      {regions.length > 1 ? (
        <div className="w-40">
          <Select
            dense
            aria-label="Region to pin this ruling on"
            value={target.id}
            options={regions.map((region) => ({
              value: region.id,
              label: nodeTitle(region),
            }))}
            onChange={(next) => {
              setRegionId(next);
              setPinned(false);
            }}
          />
        </div>
      ) : (
        <span className="text-[9px] tracking-[0.1em] text-faint uppercase">
          {nodeTitle(target)}
        </span>
      )}
    </div>
  );
}
