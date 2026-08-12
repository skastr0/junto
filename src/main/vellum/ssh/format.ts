import type { SshError } from "./domain";

/**
 * Closed operator phrases from OpenSSH stderr. Never copy remote bytes —
 * stderr can carry tokens, host keys, and escape sequences.
 */
export const classifySshStderr = (stderr: string): string | undefined => {
  const text = stderr.replaceAll("\u0000", "");
  if (/too long for Unix domain socket|unix_listener/i.test(text)) {
    return "SSH control socket path is too long for this OS";
  }
  if (/Permission denied|publickey|Authentication failed/i.test(text)) {
    return "permission denied";
  }
  if (/Host key verification failed/i.test(text)) {
    return "host key verification failed";
  }
  if (
    /Could not resolve hostname|Name or service not known|nodename nor servname/i.test(
      text,
    )
  ) {
    return "could not resolve hostname";
  }
  if (/Connection refused/i.test(text)) {
    return "connection refused";
  }
  if (/Connection timed out|Operation timed out|ETIMEDOUT/i.test(text)) {
    return "connection timed out";
  }
  return undefined;
};

export const formatSshFailure = (error: SshError): string => {
  switch (error._tag) {
    case "SshExitError":
      return error.detail !== undefined
        ? error.detail
        : `ssh exited ${error.code} during ${error.operation}`;
    case "SshTimeoutError":
      return `SSH timed out after ${error.timeoutMs}ms (${error.operation})`;
    case "SshOutputLimitError":
      return `SSH ${error.stream} exceeded ${error.limitBytes} bytes`;
    default:
      return error.message;
  }
};
