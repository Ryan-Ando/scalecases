// "Launch…" from another tab: remembers the ad and asks the app to open the Relaunch tab, whose
// Launch any ad panel picks it up (on mount, or right away when it's already mounted).
let pending = [];
export const LAUNCH_EVENT = 'sc:launch-ad';

export function requestLaunch(names) {
  pending = [...pending, ...[].concat(names)];
  window.dispatchEvent(new CustomEvent(LAUNCH_EVENT));
}

export function takeLaunchRequests() {
  const out = pending; pending = [];
  return out;
}
