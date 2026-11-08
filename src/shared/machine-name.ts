import { hostname } from "node:os";

export { isThisMachine, isValidMachineName } from "./machine-identity";

export const defaultMachineName = (source: string = hostname()): string => {
  const shortName = source
    .split(".")[0]!
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return shortName === "local" ? "machine-local" : shortName || "machine";
};
