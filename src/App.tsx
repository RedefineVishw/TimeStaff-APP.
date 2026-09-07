import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCurrentTimer,
  fetchProjects,
  fetchSettings,
  startTimer,
  stopTimer,
  tickTimer,
  type Project,
  type RunningTimer,
} from "./lib/api";
import { IdleAlertDialog } from "./IdleAlertDialog";

function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatCompact(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

const WEB_DASHBOARD_URL = "http://localhost:3001";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [running, setRunning] = useState<RunningTimer | null>(null);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(5);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [search, setSearch] = useState("");
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Set once idle crosses the threshold — shows the alert dialog instead of
  // silently acting. shownAt (wall-clock time) drives the fixed grace period
  // before an ignored dialog auto-resolves as Stop-and-discard.
  const [idleAlert, setIdleAlert] = useState<{
    idleSeconds: number;
    shownAt: number;
  } | null>(null);

  const tickInFlight = useRef(false);
  // After "Resume timer", don't re-show the alert until the user has had
  // genuine fresh activity (idle actually drops), so it doesn't instantly
  // reappear on the very next 1s check while idle is still sky-high.
  const suppressUntilActiveRef = useRef(false);
  // Mirrors idleAlert state, read synchronously inside the tick interval.
  // Crucial: once the dialog is showing, it must stay showing (and ticking
  // must stay paused) until the user explicitly resolves it — a transient
  // dip in idle seconds (e.g. just moving the mouse without clicking
  // anything) must NOT silently let ticking resume behind a stuck dialog.
  const idleAlertRef = useRef<{ idleSeconds: number; shownAt: number } | null>(null);

  function setIdleAlertBoth(value: { idleSeconds: number; shownAt: number } | null) {
    idleAlertRef.current = value;
    setIdleAlert(value);
  }

  async function loadAll() {
    try {
      const [projectsData, currentTimer, settings] = await Promise.all([
        fetchProjects(),
        fetchCurrentTimer(),
        fetchSettings(),
      ]);
      setProjects(projectsData);
      setRunning(currentTimer);
      setIdleTimeoutMinutes(settings.idleTimeoutMinutes);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError("Couldn't reach the TimeStaff backend at localhost:3000.");
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  // While running: tick the visible clock + push the tick to the backend
  // every second, and check system-wide idle time. Crossing the threshold
  // shows the alert dialog (handled below) rather than silently acting —
  // the user decides Stop (discard the idle stretch) or Resume (keep going).
  useEffect(() => {
    if (!running) return;

    const startedAt = new Date(running.startedAt).getTime();
    setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));

    // Fixed, short grace period before an ignored dialog auto-resolves —
    // independent of the configured idle threshold, so this stays
    // responsive even when someone sets a 10-minute threshold.
    const ABANDONED_GRACE_MS = 30_000;

    const freezeClock = (idleSeconds: number) =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - idleSeconds * 1000 - startedAt) / 1000)));

    const interval = setInterval(async () => {
      const idleSeconds = await window.timeStaff.getIdleSeconds();
      const thresholdSeconds = idleTimeoutMinutes * 60;

      // Dialog already up — stay paused regardless of what idleSeconds does
      // right now. Only an explicit Stop/Resume click or the abandon-grace
      // timeout (below) is allowed to leave this state.
      if (idleAlertRef.current) {
        if (Date.now() - idleAlertRef.current.shownAt >= ABANDONED_GRACE_MS) {
          const finalIdleSeconds = idleAlertRef.current.idleSeconds;
          setIdleAlertBoth(null);
          await resolveIdleStop(finalIdleSeconds);
        } else {
          setIdleAlertBoth({ ...idleAlertRef.current, idleSeconds });
          freezeClock(idleSeconds);
        }
        return;
      }

      if (idleSeconds < 5) {
        // Genuine fresh activity — safe to alert again next time idle builds up.
        suppressUntilActiveRef.current = false;
      }

      if (idleSeconds >= thresholdSeconds && !suppressUntilActiveRef.current) {
        setIdleAlertBoth({ idleSeconds, shownAt: Date.now() });
        freezeClock(idleSeconds);
        return;
      }

      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));

      if (tickInFlight.current) return;
      tickInFlight.current = true;
      try {
        await tickTimer();
      } catch {
        // A single missed tick isn't fatal — duration is finalized from
        // startedAt correctly whenever the timer eventually stops.
      } finally {
        tickInFlight.current = false;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [running, idleTimeoutMinutes]);

  async function resolveIdleStop(idleSeconds: number) {
    const idleSince = new Date(Date.now() - idleSeconds * 1000);
    try {
      await stopTimer(idleSince.toISOString());
    } catch {
      // Nothing more we can do here — leave it to the user to stop manually.
    }
    setRunning(null);
    setElapsedSeconds(0);
    setNotice(
      `Timer stopped — no activity for ${idleTimeoutMinutes} min. That idle time was discarded.`,
    );
    setProjects(await fetchProjects().catch(() => projects));
  }

  const allTimeSeconds = useMemo(
    () => projects.reduce((sum, p) => sum + p.totalSeconds, 0),
    [projects],
  );

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects
      .map((project) => ({
        ...project,
        tasks: project.tasks.filter((t) => t.name.toLowerCase().includes(q)),
      }))
      .filter((project) => project.name.toLowerCase().includes(q) || project.tasks.length > 0);
  }, [projects, search]);

  async function handleIdleDialogStop() {
    if (!idleAlert) return;
    setBusy(true);
    setIdleAlertBoth(null);
    await resolveIdleStop(idleAlert.idleSeconds);
    setBusy(false);
  }

  function handleIdleDialogResume() {
    suppressUntilActiveRef.current = true;
    setIdleAlertBoth(null);
    setNotice(null);
  }

  async function handleStartTask(taskId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entry = await startTimer(taskId);
      setRunning(entry);
    } catch {
      setError("Couldn't start the timer.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setError(null);
    try {
      await stopTimer();
      setRunning(null);
      setElapsedSeconds(0);
      setProjects(await fetchProjects());
    } catch {
      setError("Couldn't stop the timer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      {idleAlert && running && (
        <IdleAlertDialog
          idleSeconds={idleAlert.idleSeconds}
          projectName={running.task.project.name}
          taskName={running.task.name}
          onStop={handleIdleDialogStop}
          onResume={handleIdleDialogResume}
          busy={busy}
        />
      )}

      <div className="timer-row">
        <div className={`timer-box ${running && !idleAlert ? "live" : ""}`}>
          {running && !idleAlert && <span className="pulse" />}
          {formatClock(elapsedSeconds)}
        </div>
        <button
          className="round-btn"
          title="Open web dashboard"
          onClick={() => window.timeStaff.openExternal(WEB_DASHBOARD_URL)}
        >
          ↗
        </button>
      </div>

      <p className="current-project">
        {running ? running.task.project.name : "No project selected"}
      </p>
      <p className="current-task">
        {running ? running.task.name : "Click a task below to start tracking"}
      </p>

      <div className="stop-row">
        {running ? (
          <button className="circle-btn running" onClick={handleStop} disabled={busy} title="Stop">
            <span className="square" />
          </button>
        ) : (
          <div className="circle-btn idle" />
        )}
      </div>

      <div className="stats-row">
        <span>Idle timeout: {idleTimeoutMinutes}m</span>
        <span>All time: {formatCompact(allTimeSeconds)}</span>
      </div>

      {error && <p className="banner error">{error}</p>}
      {notice && <p className="banner notice">{notice}</p>}

      <input
        className="search"
        placeholder="Search projects"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="project-list">
        {filteredProjects.map((project) => {
          const isExpanded = expandedProjectId === project.id || search.trim() !== "";
          const isActive = running?.task.project.id === project.id;
          return (
            <div key={project.id} className="project-group">
              <button
                className={`project-row ${isActive ? "active" : ""}`}
                onClick={() =>
                  setExpandedProjectId(expandedProjectId === project.id ? null : project.id)
                }
              >
                <span className="dot" style={{ backgroundColor: project.color ?? "#9CA3AF" }} />
                <span className="name">{project.name}</span>
                <span className="time">{formatCompact(project.totalSeconds)}</span>
              </button>
              {isExpanded &&
                project.tasks.map((task) => (
                  <button
                    key={task.id}
                    className={`task-row ${running?.taskId === task.id ? "active" : ""}`}
                    onClick={() => handleStartTask(task.id)}
                    disabled={busy}
                  >
                    <span className="name">{task.name}</span>
                    <span className="time">{formatCompact(task.totalSeconds)}</span>
                  </button>
                ))}
            </div>
          );
        })}
        {filteredProjects.length === 0 && <p className="empty">No projects found.</p>}
      </div>

      <div className="footer">
        <button className="refresh" onClick={loadAll} title="Refresh">
          ⟳
        </button>
        <span>
          {lastUpdated ? `Last updated at: ${lastUpdated.toLocaleTimeString()}` : "Loading…"}
        </span>
      </div>
    </div>
  );
}
