import { clientLog } from "./dev-log.js";

// React 19's dev build logs every component render to the Performance panel ("Components ⚛" track) WITH a diff of
// the changed props, then hands that to performance.measure, which structured-clones it. The editor docks take the
// scene doc as a prop, and every ops batch makes a new doc: on a 6000-entity world (skelmorrow, 23 MB) one structural
// edit grew the tab from 2 GB to 9 GB in 85 s, ended in "DataCloneError ... out of memory" and left the page unable
// to answer (SHOTS-FIX 2026-10-21; with the track off the same edit takes 1.3 s). React only logs when
// console.timeStamp exists at the moment react-dom loads, so remove it before main.js is imported. The engine's own
// profiler (Shift+P) is unaffected; localStorage "hitreg-react-tracks" = "1" keeps React's track for a session.
try {
  if (localStorage.getItem("hitreg-react-tracks") !== "1") (console as { timeStamp?: unknown }).timeStamp = undefined;
} catch {
  (console as { timeStamp?: unknown }).timeStamp = undefined;
}

// Install error reporting before importing the engine and project modules.
clientLog("boot: loading modules");
void import("./main.js").catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  clientLog(`boot: module load failed: ${message}`);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `Could not start the game: ${message}`;
});
