// Download links for the Scale Cases Helper (the local app behind the Disclaimers tab and the
// local creative library). The setup files live in client/public/setup and install or update it.
const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);

export default function HelperSetup({ what = 'this' }) {
  const mac = <a href="/setup/ScaleCases-Setup-Mac.zip" download>Mac setup</a>;
  const win = <a href="/setup/ScaleCases-Setup-Windows.cmd" download>Windows setup</a>;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      To use {what} on this computer, install the Scale Cases Helper: download the {isWindows ? <>{win} (or {mac})</> : <>{mac} (or {win})</>} and open it.
      {isWindows
        ? ' If Windows says it protected your PC, click More info → Run anyway.'
        : ' Unzip it and double-click “Scale Cases Setup”. If macOS blocks it, open System Settings → Privacy & Security and click Open Anyway.'}
      {' '}It installs everything it needs, starts with the computer, and running it again updates it. Google Drive for desktop must be installed and signed in.
    </div>
  );
}
