export declare const PERMITTED_USAGE_DESCRIPTIONS: ReadonlyArray<string>;
export declare const unpermittedUsageDescriptions: (
  keys: ReadonlyArray<string>,
) => string[];
export declare const EXPECTED_APP_TRANSPORT_SECURITY: Readonly<Record<string, unknown>>;
export declare const isExpectedAppTransportSecurity: (value: unknown) => boolean;
