// Tracks whether the last call that talked to Hebits succeeded, and alerts on change. A
// search that completes without throwing is evidence the login cookie still works -
// hebits-client only returns results when the cookie it is given is still valid.
import type { Notifier } from './notify';

export interface Health {
  hebitsLogin: 'unknown' | 'ok' | 'failing';
  checkedAt: string | null;
  error: string | null;
}

export interface HealthTracker {
  health: Health;
  noteLogin: (ok: boolean, err?: string) => void;
}

export function createHealthTracker(notifier: Pick<Notifier, 'send' | 'reset'>, log: (message: string) => void): HealthTracker {
  const health: Health = { hebitsLogin: 'unknown', checkedAt: null, error: null };

  function noteLogin(ok: boolean, err?: string): void {
    const was = health.hebitsLogin;
    Object.assign(health, { hebitsLogin: ok ? 'ok' : 'failing', checkedAt: new Date().toISOString(), error: ok ? null : (err ?? null) });
    if (was === health.hebitsLogin) return;
    if (!ok) {
      log(`hebits login problem: ${err}`);
      // The recovery this names must be one that exists: the cookie lives in a file the
      // /cookie page writes, so that page is where the operator goes. This alert fires
      // exactly when the cookie has expired, so pointing it at the old Jackett indexer -
      // a service this addon no longer uses - sent the owner to fix nothing.
      notifier.send('login', 'Hebits login stopped working', `Paste a fresh cookie at the addon's /cookie page. (${err})`);
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
