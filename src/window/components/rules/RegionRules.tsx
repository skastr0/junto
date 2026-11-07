import { use$ } from "@legendapp/state/react";
import type { RegionContract } from "@shared/model/region";
import type { Rule } from "@shared/work-model";
import { setRegionContract } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { useNodeOf } from "../../lib/use-model";
import { RuleList } from "./RuleList";
import { RulingList } from "./RulingList";

/** The rules and pinned rulings of a region, read from the store's region. */
export function RegionRules({ regionId }: { readonly regionId: string }) {
  const region = useNodeOf(use$(state$.canvasName), regionId, "region");
  if (!region) return null;
  const rules = region.contract?.rules ?? [];
  const rulings = region.contract?.rulings ?? [];
  const write = (next: Partial<RegionContract>) =>
    setRegionContract(regionId, { rules, rulings, ...next });
  return <>
    <RuleList rules={rules} label="Region rules"
      hint="Every task inside this region must answer these rules."
      onChange={(next: ReadonlyArray<Rule>) => write({ rules: next })} />
    <RulingList rulings={rulings}
      onUnpin={(id) => write({ rulings: rulings.filter((ruling) => ruling.id !== id) })} />
  </>;
}
