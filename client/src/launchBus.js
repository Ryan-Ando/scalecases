// Rocket on an Ads Tracking row: queues the ad for the Relaunch tab's Launch any ad panel
// WITHOUT leaving the current tab, so several ads can be picked first. "Open launcher" (or
// requestLaunch) then switches to the Relaunch tab, whose panel picks the queue up (on mount,
// or right away when it is already mounted).
import { useSyncExternalStore } from 'react';

let pending = [];      // names the panel has not consumed yet
let queued = [];       // names picked since the launcher was last opened (drives the badge)
const listeners = new Set();
export const LAUNCH_EVENT = 'sc:launch-ad';          // open the Relaunch tab + panel

function notify() { listeners.forEach(fn => fn()); }

export function queueLaunch(names) {
  let changed = false;
  for (const n of [].concat(names)) {
    if (queued.includes(n)) continue;
    queued = [...queued, n]; pending = [...pending, n]; changed = true;
  }
  if (changed) notify();
}

export function unqueueLaunch(name) {
  if (!queued.includes(name)) return;
  queued = queued.filter(n => n !== name);
  pending = pending.filter(n => n !== name);
  notify();
}

// Switch to the Relaunch tab now; the badge count resets because the panel shows them from here
export function openLauncher() {
  queued = [];
  notify();
  window.dispatchEvent(new CustomEvent(LAUNCH_EVENT));
}

export function requestLaunch(names) {
  queueLaunch(names);
  openLauncher();
}

export function takeLaunchRequests() {
  const out = pending; pending = [];
  return out;
}

export function useLaunchQueue() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => queued);
}
