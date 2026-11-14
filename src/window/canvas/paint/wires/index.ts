/**
 * Wires for the GPU canvas (docs/canvas-gpu-architecture.md section 13).
 *
 *   route.ts   the three path sources as points, and the centreline
 *   elbow.ts   the fallback elbow, React Flow's smooth step as points
 *   strip.ts   centreline to triangle strip, never overlapping itself; the vertex layout
 *   style.ts   colour token, opacity per view, glow, pickability, transitions
 *   motion.ts  track and pulse phase on the wall clock
 *   track.ts   track runs, fits, strips and tile art
 *   pick.ts    distance to a wire and the wire a point picks
 *
 * Pure: imports only src/shared/, the pure wire modules in src/window/lib/
 * (wire-route, wire-loom, flow-track, wire-pulse) and the contract.
 */

export * from "./elbow";
export * from "./limits";
export * from "./ease";
export * from "./motion";
export * from "./pick";
export * from "./route";
export * from "./strip";
export * from "./style";
export * from "./track";
