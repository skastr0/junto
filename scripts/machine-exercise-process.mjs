// Only a child handle returned by spawn can be stopped by this helper.
export function track(child) {
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // A spawn failure may precede the caller's first await.
  closed.catch(() => {});
  return { child, closed };
}
export async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export async function stop(owned) {
  if (!owned) return undefined;
  let forced = false;
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    owned.child.kill('SIGTERM');
    try { return { ...await within(owned.closed, 8000, 'child did not stop'), forced }; }
    catch {
      forced = true;
      owned.child.kill('SIGKILL');
    }
  }
  return { ...await within(owned.closed, 3000, 'child did not close'), forced };
}
