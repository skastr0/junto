export const isValidMachineName = (value: string): boolean =>
  value !== "local" &&
  value.length > 0 &&
  value.length <= 64 &&
  /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

export const isThisMachine = (
  host: string | undefined,
  machineName: string,
): boolean => host === machineName;
