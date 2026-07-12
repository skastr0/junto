// Canonical entity keys. A binding's ref.key and its Entity.key must be
// identical strings — these builders/parsers are the single source of that
// format so adapters (which emit entities) and generators (which emit
// bindings) never drift.

export const projectKey = (key: string): string => key;

export const orbitKey = (project: string, orbit: string): string => `orbit:${project}/${orbit}`;

export const glyphKey = (project: string, orbit: string, glyphId: string): string =>
  `glyph:${project}/${orbit}/${glyphId}`;

export const sessionKey = (sessionId: string): string => `session:${sessionId}`;

export interface GlyphRef {
  readonly project: string;
  readonly orbit: string;
  readonly glyphId: string;
}

export const parseGlyphKey = (key: string): GlyphRef | undefined => {
  if (!key.startsWith("glyph:")) return undefined;
  const [project, orbit, glyphId] = key.slice("glyph:".length).split("/");
  if (!project || !orbit || !glyphId) return undefined;
  return { project, orbit, glyphId };
};

export interface OrbitRef {
  readonly project: string;
  readonly orbit: string;
}

export const parseOrbitKey = (key: string): OrbitRef | undefined => {
  if (!key.startsWith("orbit:")) return undefined;
  const [project, orbit] = key.slice("orbit:".length).split("/");
  if (!project || !orbit) return undefined;
  return { project, orbit };
};

export const parseSessionKey = (key: string): string | undefined =>
  key.startsWith("session:") ? key.slice("session:".length) : undefined;
