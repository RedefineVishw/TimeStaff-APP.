import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiErrorMessage,
  fetchCurrentTimer,
  fetchMyTimeEntries,
  fetchProjects,
  fetchProjectTasks,
  fetchTrackingSettings,
  isEntitlementError,
  logout as apiLogout,
  restoreSession,
  setSessionExpiredHandler,
  startTimer,
  stopTimer,
  uploadScreenshot,
  type AuthUser,
  type RunningTimeEntry,
  type Task,
} from "./lib/api";
import { Login } from "./Login";

const WEB_DASHBOARD_URL = "http://localhost:3000";

interface MyTask {
  id: string;
  title: string;
  todaySeconds: number;
  dueDate: string | null;
}

// startDate/dueDate arrive as the UTC-midnight instant of the calendar day
// picked on the web app (see DateRangeInput's toISODate there), not a
// specific moment in time — comparing them against "today" built the same
// way (UTC midnight of the browser's own local Y/M/D) keeps this immune to
// the timezone off-by-one bug already fixed for date *display* on the web
// app (a local-timezone read of a UTC-midnight value can land on the wrong
// calendar day for anyone not near UTC).
function todayAsUTCMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function hasNotStartedYet(startDate: string | null): boolean {
  return !!startDate && new Date(startDate).getTime() > todayAsUTCMidnight();
}

function isOverdue(dueDate: string | null | undefined): boolean {
  return !!dueDate && new Date(dueDate).getTime() < todayAsUTCMidnight();
}

interface ProjectGroup {
  id: string;
  name: string;
  todaySeconds: number;
  tasks: MyTask[];
}

function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Compact "h:mm" used for the per-project/per-task today totals in the
// sidebar, matching the reference UI's style (e.g. "4:48").
function formatCompact(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

// The org admin can configure the idle threshold as low as 15s (see the
// tracking-settings range), so "round to whole minutes" silently displayed
// "0 min" for any sub-minute value — show seconds below a minute instead.
function formatDurationLabel(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  return `${minutes} min`;
}

function flattenLeafTasks(tasks: Task[]): Task[] {
  const leaves: Task[] = [];
  for (const task of tasks) {
    if (!task.subtasks || task.subtasks.length === 0) leaves.push(task);
    else leaves.push(...flattenLeafTasks(task.subtasks));
  }
  return leaves;
}

const PROJECT_COLORS = ["#4f46e5", "#059669", "#d97706", "#db2777", "#0891b2", "#7c3aed", "#dc2626", "#65a30d"];
function colorForProject(projectId: string) {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function findTaskInfo(groups: ProjectGroup[], taskId: string): { projectName: string; title: string } | null {
  for (const group of groups) {
    const task = group.tasks.find((t) => t.id === taskId);
    if (task) return { projectName: group.name, title: task.title };
  }
  return null;
}

interface IdleAlertState {
  idleSeconds: number;
  shownAt: number;
  // Elapsed seconds (including any prior banked base) at the exact moment
  // idle began — the value the displayed clock should carry forward to if
  // the user discards this idle stretch, instead of jumping to "now".
  frozenElapsedSec: number;
  projectName: string;
  taskName: string;
}

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningTimeEntry | null>(null);
  const [idleThresholdSec, setIdleThresholdSec] = useState(300);
  const [screenshotIntervalSec, setScreenshotIntervalSec] = useState(300);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [search, setSearch] = useState("");
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idleAlert, setIdleAlert] = useState<IdleAlertState | null>(null);
  // Elapsed seconds banked from earlier segments of the *same* continuous
  // task session — carried forward across a discard-and-resume idle split
  // (see handleIdleDialogResume), reset to 0 whenever a genuinely new task
  // is started.
  const [sessionElapsedBaseSec, setSessionElapsedBaseSec] = useState(0);

  const suppressUntilActiveRef = useRef(false);
  const idleAlertRef = useRef<IdleAlertState | null>(null);

  // The idle alert now lives in a genuinely separate, always-on-top OS
  // window (see main.ts) rather than an overlay inside this window — the
  // whole point is to catch the user's attention when they come back to
  // their computer, which could be with any other app focused. This window
  // still owns all the actual state/logic; it just tells main to show the
  // popup with the data to display.
  function setIdleAlertBoth(value: IdleAlertState | null) {
    idleAlertRef.current = value;
    setIdleAlert(value);
    if (value) {
      window.timeStaff.idleAlert.show({
        idleSeconds: value.idleSeconds,
        projectName: value.projectName,
        taskName: value.taskName,
      });
    } else {
      window.timeStaff.idleAlert.hide();
    }
  }

  // A session-expired 401 (refresh also failed) drops back to the login
  // screen — wired once, module-level, since lib/api.ts has no React state
  // of its own.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      setRunning(null);
      setProjectGroups([]);
    });
  }, []);

  useEffect(() => {
    (async () => {
      const restoredUser = await restoreSession();
      if (restoredUser) {
        setUser(restoredUser);
        await loadWorkspace(restoredUser);
      }
      setBootstrapping(false);
    })();
  }, []);

  async function loadWorkspace(currentUser: AuthUser) {
    setLoadingWorkspace(true);
    setError(null);
    try {
      const todayStart = startOfToday();
      const [projects, current, todayEntries] = await Promise.all([
        fetchProjects(),
        fetchCurrentTimer(),
        fetchMyTimeEntries(todayStart.toISOString(), new Date().toISOString()),
      ]);
      const activeProjects = projects.filter((p) => p.status === "ACTIVE");

      const secondsByTask = new Map<string, number>();
      for (const entry of todayEntries) {
        secondsByTask.set(entry.taskId, (secondsByTask.get(entry.taskId) ?? 0) + (entry.durationSec ?? 0));
      }

      const tasksPerProject = await Promise.all(activeProjects.map((p) => fetchProjectTasks(p.id)));
      const groups: ProjectGroup[] = [];
      activeProjects.forEach((project, i) => {
        // Only In Progress work belongs in the tracker's task list — a To Do
        // item hasn't been picked up yet, and In Review/Done are finished as
        // far as time tracking is concerned. A task whose start date hasn't
        // arrived yet is excluded too — e.g. today is the 16th and the task
        // doesn't start until the 17th, it isn't actionable yet. (A task
        // whose *due* date has already passed stays visible — see isOverdue
        // below, it's flagged as missed rather than hidden.) The one
        // exception to all of this: whatever task currently has a running
        // timer stays visible regardless of status/dates, so an active timer
        // never disappears out from under the user mid-session.
        const myLeafTasks = flattenLeafTasks(tasksPerProject[i]).filter((t) => {
          if (t.assigneeId !== currentUser.id) return false;
          if (t.id === current?.taskId) return true;
          return t.status === "IN_PROGRESS" && !hasNotStartedYet(t.startDate);
        });
        if (myLeafTasks.length === 0) return;

        const tasks: MyTask[] = myLeafTasks.map((t) => ({
          id: t.id,
          title: t.title,
          todaySeconds: secondsByTask.get(t.id) ?? 0,
          dueDate: t.dueDate,
        }));
        groups.push({
          id: project.id,
          name: project.name,
          todaySeconds: tasks.reduce((sum, t) => sum + t.todaySeconds, 0),
          tasks,
        });
      });
      setProjectGroups(groups);
      setRunning(current);

      // Land on whichever project has the running task, or the first one —
      // matches the reference UI always showing one project's tasks open.
      const runningProjectId = current ? groups.find((g) => g.tasks.some((t) => t.id === current.taskId))?.id : null;
      setExpandedProjectId(runningProjectId ?? groups[0]?.id ?? null);

      if (currentUser.organizationId) {
        const settings = await fetchTrackingSettings(currentUser.organizationId).catch(() => null);
        if (settings) {
          setIdleThresholdSec(settings.idleThresholdSec);
          setScreenshotIntervalSec(settings.screenshotIntervalSec);
        }
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't reach the TimeStaff backend at localhost:5000."));
    } finally {
      setLoadingWorkspace(false);
    }
  }

  async function handleLoginSuccess(loggedInUser: AuthUser) {
    setUser(loggedInUser);
    await loadWorkspace(loggedInUser);
  }

  const [refreshing, setRefreshing] = useState(false);

  // Manual refresh — re-pulls projects/tasks/today's-totals from the
  // backend. Without this, a task created, reassigned, or completed on the
  // web app never shows up here until the whole desktop app is restarted,
  // since loadWorkspace() otherwise only ever runs once at login/session
  // restore. Doesn't touch `running`/`elapsedSeconds` — an in-progress
  // timer keeps ticking through a refresh exactly like it does through any
  // other background data reload.
  async function handleRefresh() {
    if (!user || refreshing) return;
    setRefreshing(true);
    try {
      await loadWorkspace(user);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogout() {
    await apiLogout();
    setUser(null);
    setRunning(null);
    setProjectGroups([]);
  }

  // Timer tick + idle detection while a timer is running. Displayed elapsed
  // = sessionElapsedBaseSec (banked from earlier segments of this same
  // session, see handleIdleDialogResume) + time since the current entry's
  // startedAt.
  useEffect(() => {
    if (!running) return;

    const startedAt = new Date(running.startedAt).getTime();
    setElapsedSeconds(sessionElapsedBaseSec + Math.floor((Date.now() - startedAt) / 1000));

    const freezeClock = (idleSeconds: number) =>
      setElapsedSeconds(
        sessionElapsedBaseSec + Math.max(0, Math.floor((Date.now() - idleSeconds * 1000 - startedAt) / 1000)),
      );

    const interval = setInterval(async () => {
      const idleSeconds = await window.timeStaff.getIdleSeconds();

      // The dialog is up and waiting — do nothing until the user explicitly
      // clicks Stop or Resume (handled by the idle-alert:response listener
      // below). No timeout, no auto-close: it stays on screen for as long
      // as it takes, even if that's a very long time.
      if (idleAlertRef.current) return;

      if (idleSeconds < 5) suppressUntilActiveRef.current = false;

      if (idleSeconds >= idleThresholdSec && !suppressUntilActiveRef.current) {
        const frozenElapsedSec =
          sessionElapsedBaseSec + Math.max(0, Math.floor((Date.now() - idleSeconds * 1000 - startedAt) / 1000));
        const taskInfo = findTaskInfo(projectGroups, running.taskId);
        setIdleAlertBoth({
          idleSeconds,
          shownAt: Date.now(),
          frozenElapsedSec,
          projectName: taskInfo?.projectName ?? running.task?.project.name ?? "—",
          taskName: taskInfo?.title ?? running.task?.title ?? "—",
        });
        freezeClock(idleSeconds);
        return;
      }

      setElapsedSeconds(sessionElapsedBaseSec + Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [running, idleThresholdSec, sessionElapsedBaseSec, projectGroups]);

  // Periodic screenshot capture while a timer is running — pixel grab
  // happens in the main process (only place with real OS access), the
  // upload happens here so it reuses the same authenticated axios instance
  // (token refresh included) instead of duplicating auth in main.
  useEffect(() => {
    if (!running) return;

    let entitlementDenied = false;
    const taskId = running.taskId;

    const interval = setInterval(async () => {
      if (entitlementDenied) return;
      // Don't capture while the idle dialog is up — the user isn't
      // confirmed to be working during this stretch, so there's nothing
      // meaningful to screenshot yet (and if discarded, the interval this
      // capture would have belonged to gets excluded from logged time
      // anyway).
      if (idleAlertRef.current) return;
      try {
        const bytes = await window.timeStaff.captureScreenshot();
        const blob = new Blob([bytes], { type: "image/png" });
        await uploadScreenshot(taskId, blob);
        // Raised from the main process (not the web Notification API) so
        // the OS toast shows TimeStaff's own icon instead of Electron's.
        window.timeStaff.notifyScreenshotCaptured();
      } catch (err) {
        if (isEntitlementError(err)) {
          // Org's plan doesn't include screenshots — stop trying instead of
          // failing silently on every interval for the rest of the session.
          entitlementDenied = true;
        }
        // Any other failure (transient network blip, etc.) just tries again
        // next interval — a single missed screenshot isn't worth surfacing.
      }
    }, screenshotIntervalSec * 1000);

    return () => clearInterval(interval);
  }, [running, screenshotIntervalSec]);

  async function resolveIdleStop(idleSeconds: number) {
    if (!running) return;
    const idleSince = new Date(Date.now() - idleSeconds * 1000);
    try {
      await stopTimer(running.id, idleSince.toISOString());
    } catch {
      // Nothing more we can do here — leave it to the user to stop manually.
    }
    setRunning(null);
    setElapsedSeconds(0);
    setSessionElapsedBaseSec(0);
    setNotice(`Timer stopped — no activity for ${formatDurationLabel(idleThresholdSec)}. That idle time was discarded.`);
  }

  // "Stop timer" in the idle dialog branches on the "Were you working?"
  // choice: discard closes out the entry excluding the idle stretch (same
  // as the abandoned-grace-period auto-stop); keep just stops normally,
  // counting the idle stretch as worked time like any other stop.
  async function handleIdleDialogStop(wasWorking: "no" | "yes") {
    if (!idleAlert || !running) return;
    setBusy(true);
    const alert = idleAlert;
    setIdleAlertBoth(null);
    if (wasWorking === "yes") {
      try {
        await stopTimer(running.id);
      } catch {
        // Leave it to the user to stop manually if this failed.
      }
      setRunning(null);
      setElapsedSeconds(0);
      setSessionElapsedBaseSec(0);
      setNotice(null);
    } else {
      await resolveIdleStop(alert.idleSeconds);
    }
    setBusy(false);
  }

  // "Resume timer" also branches on the choice. "Yes, keep idle time" just
  // dismisses the dialog and lets the same entry keep running uninterrupted
  // — the idle stretch counts as worked time, nothing to split.
  // "No, discard idle time" closes out the current entry at the moment
  // idle actually began (excluding the idle+dialog stretch from logged
  // duration) and immediately opens a fresh entry so tracking continues —
  // the displayed clock carries the pre-idle elapsed time forward instead
  // of jumping by the whole idle+dialog gap.
  async function handleIdleDialogResume(wasWorking: "no" | "yes") {
    if (!idleAlert || !running) return;
    suppressUntilActiveRef.current = true;
    const alert = idleAlert;
    setIdleAlertBoth(null);
    setNotice(null);

    if (wasWorking === "yes") {
      return;
    }

    setBusy(true);
    const idleSince = new Date(alert.shownAt - alert.idleSeconds * 1000);
    try {
      await stopTimer(running.id, idleSince.toISOString());
      const newEntry = await startTimer(running.taskId);
      setSessionElapsedBaseSec(alert.frozenElapsedSec);
      setElapsedSeconds(alert.frozenElapsedSec);
      setRunning(newEntry);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't resume the timer — start it again from the task list."));
      setRunning(null);
      setElapsedSeconds(0);
      setSessionElapsedBaseSec(0);
    } finally {
      setBusy(false);
    }
  }

  // The idle-alert window has no logic of its own — it reports the user's
  // click back through main, which forwards it here as an IPC event.
  useEffect(() => {
    return window.timeStaff.idleAlert.onResponse(({ action, wasWorking }) => {
      if (action === "stop") {
        handleIdleDialogStop(wasWorking);
      } else {
        handleIdleDialogResume(wasWorking);
      }
    });
  }, [idleAlert, running]);

  async function handleSwitchTask(taskId: string) {
    if (running?.taskId === taskId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entry = await startTimer(taskId);
      setRunning(entry);
      setSessionElapsedBaseSec(0);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't start the timer for that task."));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!running) return;
    setBusy(true);
    setError(null);
    try {
      await stopTimer(running.id);
      setRunning(null);
      setElapsedSeconds(0);
      setSessionElapsedBaseSec(0);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't stop the timer."));
    } finally {
      setBusy(false);
    }
  }

  function handleToggleProject(projectId: string) {
    setExpandedProjectId((current) => (current === projectId ? null : projectId));
  }

  // Searching flattens the accordion — every project with a name or task
  // match shows expanded, so you can jump straight to a task without first
  // hunting for which project it's under.
  const isSearching = search.trim().length > 0;
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projectGroups;
    return projectGroups
      .map((g) => ({
        ...g,
        tasks: g.name.toLowerCase().includes(q) ? g.tasks : g.tasks.filter((t) => t.title.toLowerCase().includes(q)),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [projectGroups, search]);

  const currentTask = running
    ? projectGroups.flatMap((g) => g.tasks.map((t) => ({ ...t, projectId: g.id, projectName: g.name }))).find(
        (t) => t.id === running.taskId,
      )
    : null;

  if (bootstrapping) {
    return (
      <div className="boot-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    return <Login onSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="app-shell">
      <aside className="task-panel">
        <div className="task-panel-header">
          <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#4F46E5" />
            <rect x="13.5" y="3" width="5" height="3" rx="1.2" fill="#fff" />
            <rect x="20.3" y="5" width="4" height="2.6" rx="1" fill="#fff" transform="rotate(45 22.3 6.3)" />
            <circle cx="16" cy="18.5" r="10" fill="none" stroke="#fff" strokeWidth="2.3" />
            <line x1="16" y1="18.5" x2="16" y2="12.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
            <line x1="16" y1="18.5" x2="20" y2="18.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
          </svg>
          <span className="brand-name">TimeStaff</span>
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing || loadingWorkspace}
            title="Refresh tasks"
          >
            <svg
              className={refreshing || loadingWorkspace ? "spin" : ""}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 4v6h-6" />
            </svg>
          </button>
        </div>

        <input
          className="task-search"
          placeholder="Search projects or tasks…"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="task-list">
          {loadingWorkspace ? (
            <p className="task-list-empty">Loading your projects…</p>
          ) : filteredGroups.length === 0 ? (
            <p className="task-list-empty">
              {projectGroups.length === 0 ? "No tasks assigned to you yet." : "Nothing matches your search."}
            </p>
          ) : (
            filteredGroups.map((group) => (
              <ProjectSection
                key={group.id}
                group={group}
                expanded={isSearching || expandedProjectId === group.id}
                runningTaskId={running?.taskId ?? null}
                onToggle={() => handleToggleProject(group.id)}
                onTaskClick={handleSwitchTask}
                disabled={busy}
              />
            ))
          )}
        </div>

        <div className="task-panel-footer">
          <div className="footer-user">
            <p className="footer-name">{user.firstName} {user.lastName}</p>
            <p className="footer-email">{user.email}</p>
          </div>
          <button className="footer-logout" onClick={handleLogout} title="Log out">
            ⎋
          </button>
        </div>
      </aside>

      <main className="timer-panel">
        <button
          className="dashboard-link"
          onClick={() => window.timeStaff.openExternal(WEB_DASHBOARD_URL)}
          title="Open web dashboard"
        >
          Open dashboard ↗
        </button>

        <div className={`timer-display ${running && !idleAlert ? "live" : ""}`}>
          {running && !idleAlert && <span className="pulse" />}
          {formatClock(elapsedSeconds)}
        </div>

        <p className="timer-project" style={currentTask ? { color: colorForProject(currentTask.projectId) } : undefined}>
          {currentTask?.projectName ?? "No task selected"}
        </p>
        <p className="timer-task">{currentTask?.title ?? "Pick a task from the left to start tracking"}</p>
        {isOverdue(currentTask?.dueDate) && <p className="overdue-badge">Missed due date</p>}

        <div className="timer-control-row">
          {running ? (
            <button className="control-btn running" onClick={handleStop} disabled={busy} title="Stop">
              <span className="square" />
            </button>
          ) : (
            <div className="control-btn idle" />
          )}
        </div>

        {error && <p className="banner error">{error}</p>}
        {notice && <p className="banner notice">{notice}</p>}

        <p className="idle-threshold-note">Idle discard after {formatDurationLabel(idleThresholdSec)} of inactivity</p>
      </main>
    </div>
  );
}

function ProjectSection({
  group,
  expanded,
  runningTaskId,
  onToggle,
  onTaskClick,
  disabled,
}: {
  group: ProjectGroup;
  expanded: boolean;
  runningTaskId: string | null;
  onToggle: () => void;
  onTaskClick: (taskId: string) => void;
  disabled: boolean;
}) {
  const isActiveProject = group.tasks.some((t) => t.id === runningTaskId);

  return (
    <div className="project-section">
      <button
        className={`project-row ${isActiveProject ? "active" : ""}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="project-row-dot" style={{ backgroundColor: colorForProject(group.id) }} />
        <span className="project-row-name">{group.name}</span>
        <span className="project-row-time">{formatCompact(group.todaySeconds)}</span>
        <span className={`project-row-chevron ${expanded ? "open" : ""}`}>›</span>
      </button>

      {expanded && (
        <div className="project-tasks">
          {group.tasks.map((task) => (
            <button
              key={task.id}
              className={`task-row ${task.id === runningTaskId ? "active" : ""}`}
              onClick={() => onTaskClick(task.id)}
              disabled={disabled}
            >
              <span className="task-row-title">{task.title}</span>
              {isOverdue(task.dueDate) && (
                <span className="task-row-overdue" title="Missed due date">
                  Missed due date
                </span>
              )}
              <span className="task-row-time">{formatCompact(task.todaySeconds)}</span>
              {task.id === runningTaskId && <span className="task-row-live">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
