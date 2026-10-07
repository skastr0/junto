/** Unit tests use fake credentials, never credential values inherited from the operator. */
const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|CREDENTIALS?)(?:_|$)/iu;
const OP_SESSION_NAME = /^OP_SESSION(?:_|$)/iu;
const PROXY_NAME = /^(?:ALL|HTTP|HTTPS)_PROXY$/iu;

export const unitTestEnvironment = (
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(ambient).filter(([name, value]) => {
    if (CREDENTIAL_NAME.test(name) || OP_SESSION_NAME.test(name)) return false;
    if (PROXY_NAME.test(name) && value) {
      try {
        const proxy = new URL(value);
        if (proxy.username || proxy.password) return false;
      } catch {
        // Malformed proxy configuration is not needed by unit tests.
        return false;
      }
    }
    return true;
  }));
