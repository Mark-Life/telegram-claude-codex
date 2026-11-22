/**
 * How a door outside the HTTP API that revokes a key in this process (the
 * `/apikeys` command) stops that key's running agent runs at once. `AgentRuns`
 * sets it while the API is up; with the API off there is nothing to stop. A
 * revoke from another process (the apikeys CLI, a db edit) is caught by the
 * `AgentRuns` guard on its next pass instead.
 */
let stopKey: ((keyId: string) => Promise<void>) | undefined;

/** Point the stop at the API's runs; the returned function takes it back. */
export const setApiRunStopper = (stop: (keyId: string) => Promise<void>) => {
  stopKey = stop;
  return () => {
    if (stopKey === stop) {
      stopKey = undefined;
    }
  };
};

/** Stop every running agent run of a key just revoked; best effort. */
export const stopApiRunsOfKey = async (keyId: string) => {
  await stopKey?.(keyId);
};
