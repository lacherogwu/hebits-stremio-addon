// Tracks whether the last call that talked to Hebits (through Jackett) succeeded, and
// alerts on change. A search that completes without throwing is evidence the indexer
// login still works - Jackett only returns Torznab results when it can reach Hebits.
export function createHealthTracker(notifier, log) {
  const health = { hebitsLogin: 'unknown', checkedAt: null, error: null };

  function noteLogin(ok, err) {
    const was = health.hebitsLogin;
    Object.assign(health, { hebitsLogin: ok ? 'ok' : 'failing', checkedAt: new Date().toISOString(), error: ok ? null : err });
    if (was === health.hebitsLogin) return;
    if (!ok) {
      log(`hebits login problem: ${err}`);
      notifier.send('login', 'Hebits login stopped working', `Update the HeBits indexer cookie in Jackett. (${err})`);
    } else if (was === 'failing') {
      // Only a recovery from an actual failure is news; a cold start's first success
      // (was === 'unknown') should update health silently, not announce a "recovery"
      // from nothing.
      notifier.reset('login');
      notifier.send('login-ok', 'Hebits login works again', 'Searching resumed.', { force: true });
    }
  }

  return { health, noteLogin };
}
