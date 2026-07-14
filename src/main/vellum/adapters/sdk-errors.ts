// Shared error-to-string projection for every tower.ts/tower-browse.ts/
// quasar.ts SDK call site. Both @skastr0/tower-sdk and @skastr0/quasar-sdk
// errors are Schema.TaggedError instances that carry a `message: string`
// field, so a single structural check covers either SDK's whole error union
// without importing either by name.
export const describeSdkError = (error: unknown): string =>
  error !== null &&
  typeof error === "object" &&
  "message" in error &&
  typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "SDK request failed";
