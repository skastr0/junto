import { FileText, GitBranch, Globe, Link2 } from "lucide-react";
import type { NodeOf } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { machineLabelIn, useMachines } from "../../lib/machines";
import { SpineCard, type SpineHue } from "./SpineCard";

/**
 * What another machine's canvas puts on this one (docs/node-card-language.md):
 * a peer seat and a stub copy, each a dashed chip that says where it lives.
 * Nothing here is started or driven; the machine that holds it does that.
 */

/** A seat that lives on another machine: a dashed portrait disc, "seat on <machine>". */
export function PeerCard({ node }: { readonly node: NodeOf<"peer"> }) {
  const machine = machineLabelIn(useMachines(), node.host);
  const name = titleOf(node);
  return (
    <SpineCard
      glyph={null}
      portrait={<span className="spine-portrait">{name.slice(0, 1).toUpperCase()}</span>}
      hue="dim"
      name={name}
      dashed
      spokenKind={`seat on ${machine}`}
      body={{ kind: "leaf", line: `seat on ${machine}` }}
    />
  );
}

const STUB_LOOK: { readonly [K in NodeOf<"stub">["of"]]: { readonly glyph: typeof FileText; readonly hue: SpineHue } } = {
  file: { glyph: FileText, hue: "dim" },
  link: { glyph: Link2, hue: "cyan" },
  git: { glyph: GitBranch, hue: "orange" },
  page: { glyph: Globe, hue: "indigo" },
};

/** A copy of another machine's node: its kind's chip, dashed, "<kind> on <machine>". */
export function StubCard({ node }: { readonly node: NodeOf<"stub"> }) {
  const machines = useMachines();
  const where = node.host === undefined ? undefined : machineLabelIn(machines, node.host);
  const look = STUB_LOOK[node.of];
  const Glyph = look.glyph;
  const line = where === undefined ? `${node.of} copy` : `${node.of} on ${where}`;
  return (
    <div className="spine-stub">
      <SpineCard
        glyph={<Glyph />}
        hue={look.hue}
        name={titleOf(node)}
        dashed
        spokenKind={where === undefined ? `${node.of} copy` : `${node.of} copy on ${where}`}
        body={{ kind: "leaf", line }}
      />
    </div>
  );
}
