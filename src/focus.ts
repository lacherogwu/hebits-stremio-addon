// "Focus" on one file while it's being watched: raise its priority so it downloads
// ahead of the rest of the torrent, then put everything back to normal.
//
// Measured on qBittorrent 5.2.3 / libtorrent 1.2: pausing the other files stalls the
// whole torrent for 10-60 s (cancelled requests), so this addon never pauses a file
// itself. It does un-pause, though: Hebits only counts seed time once a torrent is 100%
// downloaded, so files the user deselected in a torrent this addon manages are put back
// to normal priority so that torrent can actually finish and start earning seed time.
// That's scoped to torrents this addon added (see `managed` below) - a torrent it didn't
// add keeps whatever selection the user chose, paused files included.
import type { FocusEntry } from './store';

export const PAUSED = 0;
export const NORMAL = 1;
export const TOP = 7;
const HIGH = 6;

// The slice of a qBittorrent file entry that focus decisions read (kept narrow rather
// than importing QFile, so a test fixture needs no unused `name`/`size` fields).
export interface FocusFile {
  index: number;
  progress: number;
  priority: number;
}

export function focusPlan(qfiles: FocusFile[], targetIndex: number): { raise: number[] } {
  const target = qfiles.find((f) => f.index === targetIndex);
  return { raise: target && target.priority !== TOP && target.progress < 1 ? [targetIndex] : [] };
}

// Anything not at normal priority goes back to normal. Paused files are only part of
// that for `managed` torrents (this addon's own watch category) - see the module
// comment above for why paused files matter at all.
export function restorePlan(qfiles: FocusFile[], managed: boolean): number[] {
  const priorities = managed ? [PAUSED, HIGH, TOP] : [HIGH, TOP];
  return qfiles.filter((f) => priorities.includes(f.priority)).map((f) => f.index);
}

// `nowMs` and `focus.at` are both epoch milliseconds (Date.now()) - this addon's own
// bookkeeping timestamp, never one of qBittorrent's seconds-based fields (added_on,
// completion_on, seeding_time). `idleMs` is likewise a millisecond duration.
export function shouldRestore(focus: Pick<FocusEntry, 'file' | 'at'>, qfiles: FocusFile[], nowMs: number, idleMs: number): boolean {
  const target = qfiles.find((f) => f.index === focus.file);
  if (!target || target.progress >= 1) return true;
  return nowMs - focus.at > idleMs;
}
