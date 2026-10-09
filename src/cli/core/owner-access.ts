import { WORK_TOKEN_ENV } from "@shared/work-control";

export const OWNER_COMMAND_REFUSAL = "Owner and machine commands are unavailable from a Junto seat.";

export const ownerCommandRefusal = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => environment[WORK_TOKEN_ENV] !== undefined ? OWNER_COMMAND_REFUSAL : undefined;
