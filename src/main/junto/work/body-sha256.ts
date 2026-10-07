import { createHash } from "node:crypto";

/** Hash the exact UTF-8 bytes of retained projection material. */
export const bodySha256Of = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");
