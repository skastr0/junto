import type { CanvasNode, EtherRegionContract } from "@shared/canvas";
import type { Rule } from "@shared/work-model";
import { setRegionContract } from "../../lib/mutations";
import { RuleList } from "./RuleList";
import { RulingList } from "./RulingList";

export function RegionRules({ node }: { readonly node: CanvasNode }) {
  if (node.type !== "group") return null;
  const contract = node.ether?.region?.contract;
  const rules = contract?.rules ?? [];
  const rulings = contract?.rulings ?? [];
  const write = (next: Partial<EtherRegionContract>) =>
    setRegionContract(node.id, { rules, rulings, ...next });
  return <>
    <RuleList rules={rules} label="Region rules"
      hint="Every task inside this region must answer these rules."
      onChange={(next: ReadonlyArray<Rule>) => write({ rules: next })} />
    <RulingList rulings={rulings}
      onUnpin={(id) => write({ rulings: rulings.filter((ruling) => ruling.id !== id) })} />
  </>;
}
