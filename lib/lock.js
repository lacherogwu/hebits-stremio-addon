// A tiny per-key async mutex: serializes operations that share a key so two concurrent
// calls can never interleave. Each key's chain cleans up after itself once idle, and a
// failed operation never becomes an unhandled rejection on top of the error its own
// caller already sees.
export function makeLock() {
  const locks = new Map();
  return function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const cleanup = run.catch(() => {}).finally(() => locks.get(key) === cleanup && locks.delete(key));
    locks.set(key, cleanup);
    return run;
  };
}
