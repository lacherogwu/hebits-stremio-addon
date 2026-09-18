// "Focus" on one file while it's being watched: raise its priority so it downloads
// ahead of the rest of the torrent, then put everything back to normal.
//
// Measured on qBittorrent 5.2.3 / libtorrent 1.2: pausing the other files stalls the
// whole torrent for 10-60 s (cancelled requests), so nothing is ever paused. That also
// keeps Hebits' rule safe: seed time only counts once 100% of a torrent is downloaded.

export const PAUSED = 0;
export const NORMAL = 1;
export const TOP = 7;
const HIGH = 6;

export function focusPlan(qfiles, targetIndex) {
  const target = qfiles.find((f) => f.index === targetIndex);
  return { raise: target && target.priority !== TOP && target.progress < 1 ? [targetIndex] : [] };
}

// Anything not at normal priority goes back to normal, including files paused by hand:
// a partially downloaded torrent never starts counting seed time.
export function restorePlan(qfiles) {
  return qfiles.filter((f) => [PAUSED, HIGH, TOP].includes(f.priority)).map((f) => f.index);
}

export function shouldRestore(focus, qfiles, now, idleMs) {
  const target = qfiles.find((f) => f.index === focus.file);
  if (!target || target.progress >= 1) return true;
  return now - focus.at > idleMs;
}
