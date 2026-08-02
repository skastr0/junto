import { Schema } from "effect";

/** Stable identity of one Vellum Command database installation. */
export const InstallationId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)),
  Schema.brand("InstallationId"),
);
export type InstallationId = typeof InstallationId.Type;
