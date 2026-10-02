/* Chrome adapter: reads saved data, runs the shared engine, reports back to the popup.
   Runs in every frame — ATS forms are often iframed (Greenhouse, Lever), so each frame
   fills what it can and reports independently. The fill logic itself lives in engine.js. */

var JA = (self.JA = self.JA || {}); // var, not const: content scripts share one global scope

async function runFromStorage(msg) {
  const { profile, snippets, settings, resumeFile } = await JA.load();
  return JA.run({
    profile,
    snippets,
    settings,
    resumeFile,
    overwrite: msg.opts?.overwrite ?? settings.overwriteExisting,
    useSnippets: msg.opts?.useSnippets ?? settings.useSnippets,
    dryRun: msg.type === 'JA_SCAN',
  });
}

function onMessage(msg) {
  if (!msg || (msg.type !== 'JA_FILL' && msg.type !== 'JA_SCAN')) return;
  runFromStorage(msg)
    .then((report) => {
      // Quiet frames (ads, trackers, chrome) shouldn't clutter the popup.
      if (report.entries.length === 0) return;
      chrome.runtime.sendMessage({ type: 'JA_REPORT', report }).catch(() => {});
    })
    .catch((err) => {
      chrome.runtime.sendMessage({ type: 'JA_REPORT', report: { error: String(err), entries: [] } }).catch(() => {});
    });
  // No synchronous response — reports arrive via JA_REPORT so every frame can answer.
}

// Reloading the extension orphans the copy of this script already living in an open tab:
// its listener is dead but its globals survive, because re-injection reuses the same
// isolated world. So drop any previous listener before registering — that keeps exactly
// one live listener whether we arrived by manifest injection or by the popup's fallback
// injection, and avoids duplicated reports.
if (self.__jaListener) {
  try {
    chrome.runtime.onMessage.removeListener(self.__jaListener);
  } catch {
    /* previous context already invalidated */
  }
}
self.__jaListener = onMessage;
chrome.runtime.onMessage.addListener(onMessage);
