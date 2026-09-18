import { useEffect, useState } from "react";

function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

interface MiniTimerData {
  taskName: string;
  projectName: string;
  elapsedSeconds: number;
  status: "running" | "paused" | "idle-warning" | "idle-critical";
}

// The content of the separate always-on-top mini-timer window (see
// main.ts's createMiniTimerWindow) — a VM-guest-style floating strip that
// stays visible over whatever else you're working in. Deliberately "dumb"
// like the idle-alert window: it only displays whatever the main window's
// renderer last sent it and reports button clicks back; all the real
// pause/resume/close logic lives in App.tsx.
export function MiniTimerWindowApp() {
  const [data, setData] = useState<MiniTimerData | null>(null);

  useEffect(() => {
    return window.timeStaff.miniTimer.onData(setData);
  }, []);

  // This window is created with `transparent: true` in main.ts so its
  // corners can actually be rounded against the desktop behind it — but
  // the app's own global stylesheet paints an opaque background on <body>
  // for every other window, which would defeat that. Scoped to just this
  // route instead of touching the shared CSS defaults.
  useEffect(() => {
    document.body.classList.add("mini-timer-window");
    return () => document.body.classList.remove("mini-timer-window");
  }, []);

  if (!data) return null;

  const isPaused = data.status === "paused";
  const isIdleWarning = data.status === "idle-warning";
  const isIdleCritical = data.status === "idle-critical";
  const barStateClass = isIdleCritical ? "critical" : isIdleWarning ? "warning" : "";
  const dotStateClass = isPaused ? "paused" : isIdleCritical ? "critical" : isIdleWarning ? "warning" : "running";

  return (
    <div className="mini-timer-stage">
    <div className={`mini-timer ${barStateClass}`}>
      <span className="mini-timer-handle" title="Drag to move">
        <span className="mini-timer-handle-dot" />
        <span className="mini-timer-handle-dot" />
        <span className="mini-timer-handle-dot" />
        <span className="mini-timer-handle-dot" />
        <span className="mini-timer-handle-dot" />
        <span className="mini-timer-handle-dot" />
      </span>

      <button
        className="mini-timer-toggle"
        onClick={() => window.timeStaff.miniTimer.respondAction(isPaused ? "resume" : "pause")}
        title={isPaused ? "Resume" : "Pause"}
        aria-label={isPaused ? "Resume" : "Pause"}
      >
        {isPaused ? <span className="mini-timer-play-icon" /> : <span className="mini-timer-pause-icon" />}
      </button>

      <span className={`mini-timer-dot ${dotStateClass}`} />

      <span className="mini-timer-task" title={`${data.projectName} — ${data.taskName}`}>
        {data.taskName}
      </span>

      <span className="mini-timer-clock">{formatClock(data.elapsedSeconds)}</span>

      <button
        className="mini-timer-close"
        onClick={() => window.timeStaff.miniTimer.respondAction("dismiss")}
        title="Dismiss"
        aria-label="Dismiss"
      >
        <span className="mini-timer-close-icon" />
      </button>
    </div>
    </div>
  );
}
