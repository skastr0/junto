export declare const machineSigningIdentifier: (relative: string) => string;
export declare const machineNeedsJit: (relative: string) => boolean;
export declare const machineMachOFiles: (directory: string) => Promise<string[]>;
export declare const signMachineBundle: (
  directory: string,
  target: string,
  environment?: Readonly<Record<string, string | undefined>>,
  run?: (program: string, args: string[], options: { stdio: string; timeout: number }) => unknown,
) => Promise<void>;
