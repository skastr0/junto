/**
 * Region roll call — situation strip for the RTS command card.
 * Hot severity buckets only; not a clickable member directory (v1).
 */
import type { RegionRollup } from "@shared/region-rollup";
import { signalMark } from "../../lib/signal-mark";
import {
  buildRollCall,
  rollCallBucketLabel,
  type RollCallBucket,
} from "../../lib/roll-call";

function BucketRow({ bucket }: { readonly bucket: RollCallBucket }) {
  const mark = signalMark(bucket.severity);
  const nameLine =
    bucket.names.length === 0
      ? null
      : bucket.extra > 0
        ? `${bucket.names.join(", ")} +${bucket.extra}`
        : bucket.names.join(", ");

  return (
    <div className="rts-rollcall__bucket" data-severity={bucket.severity}>
      <span className="rts-rollcall__mark" aria-hidden style={{ color: mark.hue }}>
        {mark.symbol}
      </span>
      <div className="rts-rollcall__copy">
        <span className="rts-rollcall__count" style={{ color: mark.hue }}>
          {rollCallBucketLabel(bucket.severity, bucket.count)}
        </span>
        {nameLine ? <span className="rts-rollcall__names">{nameLine}</span> : null}
      </div>
    </div>
  );
}

export function RollCall({ rollup }: { readonly rollup: RegionRollup }) {
  const model = buildRollCall(rollup);

  if (model.kind === "empty") {
    return (
      <div className="rts-rollcall" aria-label="Roll call">
        <div className="rts-rollcall__quiet">Empty</div>
      </div>
    );
  }

  if (model.kind === "quiet") {
    return (
      <div className="rts-rollcall" aria-label="Roll call">
        <div className="rts-rollcall__quiet">All quiet</div>
      </div>
    );
  }

  return (
    <div className="rts-rollcall" aria-label="Roll call" role="list">
      {model.buckets.map((bucket) => (
        <div key={bucket.severity} role="listitem">
          <BucketRow bucket={bucket} />
        </div>
      ))}
    </div>
  );
}
