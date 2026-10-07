/**
 * The app briefing and references: the operator's own AGENTS.md style text,
 * kept in Junto instead of in files.
 *
 * - The briefing is one app-wide text. Every seat gets it on `junto onboard`.
 * - A reference is a named piece of prose, app-wide or belonging to a region.
 *   It is never sent to a seat: onboard lists names and descriptions, and a
 *   seat reads one with `junto references read <name>` when it needs it.
 *
 * All of it lives in junto.db `app_texts`. A region reference is keyed by its
 * canvas and the region's node id. Renderer and CLI safe: no node or Effect
 * imports.
 */

export const REFERENCE_NAME_MAX = 80;
const REFERENCE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** One reference. No bound on description or body. */
export type Reference = {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
};

/** A reference as stored: the shape plus when it last changed. */
export type StoredReference = Reference & { readonly updatedAt: number };

export type ReferenceScope = "app" | "region";
export type ReferenceRegion = { readonly id: string; readonly label: string };

/** A reference placed in a seat's scope: app-wide, or one region's. */
export type ScopedReference = StoredReference & {
  readonly scope: ReferenceScope;
  readonly region?: ReferenceRegion;
};

/** One line of the onboard `references` list: never a body. */
export type ReferenceListing = {
  readonly name: string;
  readonly description?: string;
  readonly scope: ReferenceScope;
  readonly region?: ReferenceRegion;
  readonly read: string;
};

/** One line of `junto references list`. */
export type ReferenceListEntry = ReferenceListing & {
  readonly bytes: number;
  readonly updatedAt: number;
};

/** `junto references read <name>`. */
export type ReferenceReadResult = ScopedReference;

/** Where a reference is kept: the app, or one region of one canvas. */
export type ReferencePlace =
  | { readonly kind: "app" }
  | { readonly kind: "region"; readonly canvasName: string; readonly regionId: string };

export const APP_REFERENCE_PLACE: ReferencePlace = { kind: "app" };

export type AppBriefing = { readonly body: string; readonly updatedAt: number };

/** Who wrote a row: the operator in the window, or an overseer seat. */
export type ReferenceAuthor = "operator" | `overseer:${string}`;

/** Main -> renderer: something in the store changed; open pages read again. */
export type ReferencesChangedEvent =
  | { readonly kind: "briefing" }
  | {
      readonly kind: "reference";
      readonly name: string;
      /** Set for a region's reference; absent for an app-wide one. */
      readonly canvasName?: string;
      readonly regionId?: string;
    };

export type ReferenceWriteInput = {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
};

export type ReferencesResult<A> =
  | ({ readonly ok: true } & A)
  | { readonly ok: false; readonly message: string };

export type ReferenceNameResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string };

/**
 * A name is typed as one command argument, so it is lower-cased and held to
 * letters, digits, dot, underscore and dash. That is the only bound.
 */
export function normalizeReferenceName(value: unknown): ReferenceNameResult {
  if (typeof value !== "string") return { ok: false, message: "a reference name must be text" };
  const name = value.trim().toLowerCase();
  if (name.length === 0) return { ok: false, message: "a reference needs a name" };
  if (name.length > REFERENCE_NAME_MAX) {
    return { ok: false, message: `the name is ${name.length} characters; keep it to ${REFERENCE_NAME_MAX}` };
  }
  if (!REFERENCE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `"${name}" is not a usable name: start with a letter or digit, then letters, digits, dot, underscore or dash`,
    };
  }
  return { ok: true, name };
}

/** Prose as stored: CRLF to LF, no NUL, trimmed; empty is absent. */
export const cleanReferenceText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- NUL never belongs in a prompt
  const text = value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  return text.length > 0 ? text : undefined;
};

export const referenceReadCommand = (name: string): string => `junto references read ${name}`;

const utf8 = new TextEncoder();
export const referenceBytes = (body: string): number => utf8.encode(body).length;

/** A region reference as stored, tagged with the region it belongs to. */
export type RegionReference = StoredReference & { readonly regionId: string };

/**
 * Everything a seat can read: the app's references, then each region it sits
 * in from outer to inner. A name met again further in replaces the outer one
 * where it stood, the rule region environment uses.
 */
export function referencesInScope(input: {
  readonly app: ReadonlyArray<StoredReference>;
  /** Outer to inner. */
  readonly regions: ReadonlyArray<ReferenceRegion>;
  readonly regional: ReadonlyArray<RegionReference>;
}): ReadonlyArray<ScopedReference> {
  const byName = new Map<string, ScopedReference>();
  for (const reference of input.app) byName.set(reference.name, { ...reference, scope: "app" });
  for (const region of input.regions) {
    for (const { regionId, ...reference } of input.regional) {
      if (regionId !== region.id) continue;
      byName.set(reference.name, { ...reference, scope: "region", region });
    }
  }
  return [...byName.values()];
}

export const toReferenceListing = (reference: ScopedReference): ReferenceListing => ({
  name: reference.name,
  ...(reference.description !== undefined ? { description: reference.description } : {}),
  scope: reference.scope,
  ...(reference.region !== undefined ? { region: reference.region } : {}),
  read: referenceReadCommand(reference.name),
});

export const toReferenceListEntry = (reference: ScopedReference): ReferenceListEntry => ({
  ...toReferenceListing(reference),
  bytes: referenceBytes(reference.body),
  updatedAt: reference.updatedAt,
});

export const toReferenceReadResult = (reference: ScopedReference): ReferenceReadResult => ({
  name: reference.name,
  ...(reference.description !== undefined ? { description: reference.description } : {}),
  scope: reference.scope,
  ...(reference.region !== undefined ? { region: reference.region } : {}),
  body: reference.body,
  updatedAt: reference.updatedAt,
});
