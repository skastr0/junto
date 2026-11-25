/**
 * Whether the error banner offers "retry save". Only for the failure a retry
 * can fix, which main marked by kind (src/shared/model-failure.ts) and the
 * window kept as `state$.retryableError`; compared as a whole with the
 * banner's text, so a later, different error never inherits the offer.
 */
export const offersRetry = (message: string, retryable: string): boolean => retryable !== "" && retryable === message;
