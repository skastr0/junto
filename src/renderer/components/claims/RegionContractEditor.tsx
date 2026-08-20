import type { CanvasNode } from "@shared/canvas";
import type { ClaimDef, EtherRegionContract } from "@shared/canvas";
import { setRegionContract } from "../../lib/mutations";
import { ClaimList } from "./ClaimList";
import { RulingList } from "./RulingList";

// Region standing law, beside the briefing. Claims stack outer -> inner
// across every region containing a sink, so an outer region's claims reach
// every task closing anywhere inside it.

export function RegionContractEditor({ node }: { readonly node: CanvasNode }) {
  if (node.type !== "group") return null;
  const contract = node.ether?.region?.contract;
  const claims = contract?.claims ?? [];
  const rulings = contract?.rulings ?? [];

  const write = (next: Partial<EtherRegionContract>) => {
    const merged: EtherRegionContract = { claims, rulings, ...next };
    setRegionContract(node.id, merged);
  };

  return (
    <>
      <ClaimList
        ownerNodeId={node.id}
        claims={claims}
        label="claims"
        hint="Every task closing at a sink inside this region answers these. Hard claims block the close, soft claims may be waived with a reason."
        onChange={(next: ReadonlyArray<ClaimDef>) => write({ claims: next })}
      />
      <RulingList
        rulings={rulings}
        onUnpin={(id) => write({ rulings: rulings.filter((ruling) => ruling.id !== id) })}
      />
    </>
  );
}
