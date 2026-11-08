export declare const linuxAttemptRootOf: (
  candidate: unknown,
) => string | undefined;

export declare const isExpectedLinuxArtifactRoot: (
  candidate: unknown,
) => boolean;

declare const afterPack: (context: unknown) => Promise<void>;

export default afterPack;
