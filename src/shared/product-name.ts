/**
 * Product brand invariant.
 *
 * Public product name is **Junto**. The retired brand mark is
 * forbidden in every prose surface (enforced by `bun run lint:product-name`,
 * see scripts/lint-product-name.ts). Runtime identifiers (`JuntoApi`,
 * `~/.junto/`, `junto.db`, `junto://`, and `junto`) are canonical surfaces.
 * Source paths and package names remain implementation identifiers only.
 * Every user-facing / public string that names the product must use
 * PRODUCT_NAME.
 */
export const PRODUCT_NAME = "Junto" as const;

/** Bundle / executable name on macOS (`Junto.app`). */
export const PRODUCT_APP_BUNDLE_NAME = `${PRODUCT_NAME}.app` as const;

/** Artifact prefix for release filenames (`Junto-…`). */
export const PRODUCT_ARTIFACT_PREFIX = "Junto" as const;
