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
      log(`hebits search failing: ${err}`);
      // Say only what this actually knows. noteLogin(false) is called from addon.ts's
      // searchFailed() for ANY search error - HTTP 500, DNS failure, a schema change -
      // not just an expired cookie, so asserting "the login stopped working" and
      // prescribing a paste would, during an unrelated tracker outage, send the owner to
      // replace a cookie that is working fine. The evidence is that searches are failing;
      // the expired cookie is the likely cause, not the established one. /cookie stays in
      // the text because it remains the action when the cause IS the cookie.
      notifier.send(
        'login',
        'Hebits searches are failing',
        `Usually an expired login - paste a fresh cookie at the addon's /cookie page. (${err})`,
      );
    } else if (was === 'failing') {
      // Only a recovery from an actual failure is news; a cold start's first success
      // (was === 'unknown') should update health silently, not announce a "recovery"
      // from nothing.
      notifier.reset('login');
      notifier.send('login-ok', 'Hebits searches are working again', 'Searching resumed.', { force: true });
    }
  }

  return { health, noteLogin };
}
