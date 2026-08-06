/**
 * Product brand invariant.
 *
 * Public product name is always **Vellum Command** — never the bare product
 * token without Command.
 * Runtime identifiers (`VellumCommandApi`, `~/.vellum-command/`, `vellum-command.db`,
 * `vellum-command://`, and `vellum-command`) are canonical surfaces. Source paths and package names
 * remain implementation identifiers only. Every user-facing / public string
 * that names the product must use PRODUCT_NAME.
 *
 * Enforced by `bun run lint:product-name` (see scripts/lint-product-name.ts).
 */
export const PRODUCT_NAME = "Vellum Command" as const;

/** Bundle / executable name on macOS (`Vellum Command.app`). */
export const PRODUCT_APP_BUNDLE_NAME = `${PRODUCT_NAME}.app` as const;

/** Artifact prefix for release filenames (`Vellum-Command-…`). */
export const PRODUCT_ARTIFACT_PREFIX = "Vellum-Command" as const;
