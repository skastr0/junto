import { Schema } from "effect";

/** Stable identity of one Vellum Command database installation. */
export const InstallationId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  Schema.brand("InstallationId"),
);
export type InstallationId = typeof InstallationId.Type;
