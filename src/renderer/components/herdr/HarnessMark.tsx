import { markTileFor, marks, type MarksService } from "../../lib/harness-icons";
import { withAlpha } from "../../lib/theme";

// Brand identity chip for a herdr agent harness: the harness glyph when brand
// path data exists, else a monogram on the agent's deterministic hue. An
// absent agent never monograms the word "agent" — it gets a quiet terminal
// prompt mark in DIM. Purely presentational — pointer-events none so the hero
// button beside it owns the card gestures. Proportions follow the 28px card
// tile (8px radius, 15px glyph, 12px monogram) and scale linearly with `size`.
// Resolution runs through markTileFor against the MarksService contract; the
// `marks` prop defaults to the house repository and exists as a test seam.
export function HarnessMark({
  agent,
  size,
  focused = false,
  marks: service = marks,
}: {
  readonly agent?: string;
  readonly size: number;
  readonly focused?: boolean;
  readonly marks?: MarksService;
}) {
  const tile = markTileFor(agent, service);
  const inner = Math.round((size * 15) / 28);
  return (
    <span
      aria-hidden
      className="pointer-events-none grid shrink-0 select-none place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round((size * 8) / 28),
        background: withAlpha(tile.hue, tile.known ? 0.14 : 0.1),
        border: `1px solid ${withAlpha(tile.hue, focused ? 0.6 : 0.28)}`,
      }}
      title={`${tile.displayName}${focused ? " · focused in herdr" : ""}`}
    >
      {tile.glyph ? (
        <svg
          viewBox={tile.viewBox}
          width={inner}
          height={inner}
          fill={tile.hue}
          style={{ display: "block", flex: "none" }}
          aria-hidden
        >
          {tile.paths.map((d, index) => (
            <path key={`${index}-${d.slice(0, 24)}`} d={d} fillRule={tile.fillRule} clipRule={tile.fillRule} />
          ))}
        </svg>
      ) : tile.known ? (
        <span
          style={{
            display: "grid",
            placeItems: "center",
            color: tile.hue,
            fontSize: Math.round((size * 11) / 28),
            fontWeight: 650,
            lineHeight: 1,
            width: "100%",
            height: "100%",
          }}
        >
          {tile.displayName.charAt(0).toUpperCase()}
        </span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width={inner}
          height={inner}
          fill="none"
          stroke={tile.hue}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 6l6 6-6 6" />
          <path d="M13 18h6" />
        </svg>
      )}
    </span>
  );
}
