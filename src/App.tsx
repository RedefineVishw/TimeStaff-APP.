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
import { SettingsPage } from "./SettingsPage";
import { getScreenshotAlertPosition } from "./lib/settings";

const WEB_DASHBOARD_URL = "http://localhost:3000";

interface MyTask {
  id: string;
  title: string;
  description: string | null;
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

// The org admin can configure the idle threshold as low as 30s (see the
// tracking-settings range), so "round to whole minutes" would show
// "1 min" for a 30s threshold and misstate it for any sub-minute value — show seconds below a minute instead.
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

// Red is deliberately excluded — it's reserved for the Stop button and
// overdue/error states elsewhere in this UI, so a red project dot would
// read as a warning instead of just being that project's color.
const PROJECT_COLORS = ["#6366f1", "#3b82f6", "#16a34a", "#f59e0b", "#ec4899", "#64748b", "#0891b2", "#8b5cf6"];
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

// "Sep 20" — short enough for a fixed-height row, still a real date rather
// than a made-up placeholder.
function formatDueDate(dueDate: string): string {
  return new Date(dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "09/18/2026 05:41 PM" — matches the reference UI's "Last updated at"
// stamp next to the refresh control.
function formatLastUpdated(date: Date): string {
  const datePart = date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${datePart} ${timePart}`;
}

function findTaskInfo(
  groups: ProjectGroup[],
  taskId: string,
): { projectName: string; title: string; todaySeconds: number } | null {
  for (const group of groups) {
    const task = group.tasks.find((t) => t.id === taskId);
    if (task) return { projectName: group.name, title: task.title, todaySeconds: task.todaySeconds };
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningTimeEntry | null>(null);
  const [idleThresholdSec, setIdleThresholdSec] = useState(300);
  const [screenshotIntervalSec, setScreenshotIntervalSec] = useState(300);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [search, setSearch] = useState("");
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Which top-level page is showing. Just a view swap — the timer, idle
  // detection and floating widget all live in this component and keep
  // running while Settings is open.
  const [view, setView] = useState<"home" | "settings">("home");
  const [idleAlert, setIdleAlert] = useState<IdleAlertState | null>(null);
  // Set when the floating mini-timer widget's own pause button is used —
  // distinct from a full Stop: the session's time is already folded into
  // the task's total (see handleMiniTimerPause), but the widget stays
  // visible with a Resume button rather than disappearing, and this is
  // what that button restarts.
  const [pausedTask, setPausedTask] = useState<{ id: string; title: string; projectName: string } | null>(null);
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
      // The idle dialog is about to take over attention — the mini-timer
      // widget disappears rather than sitting there ticking on top of it.
      // It comes back explicitly wherever the dialog resolves in a way
      // that keeps tracking alive (see handleIdleDialogResume).
      window.timeStaff.miniTimer.hide();
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
          description: t.description,
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
      // matches the reference UI always showing one project selected.
      const runningProjectId = current ? groups.find((g) => g.tasks.some((t) => t.id === current.taskId))?.id : null;
      setSelectedProjectId(runningProjectId ?? groups[0]?.id ?? null);

      if (currentUser.organizationId) {
        const settings = await fetchTrackingSettings(currentUser.organizationId).catch(() => null);
        if (settings) {
          setIdleThresholdSec(settings.idleThresholdSec);
          setScreenshotIntervalSec(settings.screenshotIntervalSec);
        }
      }
      setLastUpdatedAt(new Date());
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

  // Folds a just-finished session's duration into the task's (and its
  // project's) `todaySeconds` right away — without this, a task's total
  // only ever updated on the next full Refresh/reload, so stopping a timer
  // and starting it again looked like it "forgot" every session before the
  // current one, and the project header (which never added the live
  // elapsedSeconds in the first place) stayed stuck wherever it was at
  // load time.
  function foldElapsedIntoTask(taskId: string, seconds: number) {
    if (seconds <= 0) return;
    setProjectGroups((groups) =>
      groups.map((g) => {
        if (!g.tasks.some((t) => t.id === taskId)) return g;
        return {
          ...g,
          todaySeconds: g.todaySeconds + seconds,
          tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, todaySeconds: t.todaySeconds + seconds } : t)),
        };
      }),
    );
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
    if (running) {
      try {
        await stopTimer(running.id);
      } catch {
        // Best-effort — logging out regardless.
      }
    }
    await apiLogout();
    setUser(null);
    setRunning(null);
    setProjectGroups([]);
    setPausedTask(null);
    window.timeStaff.miniTimer.hide();
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

      const tickElapsed = sessionElapsedBaseSec + Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(tickElapsed);

      // Warn on the mini-timer widget for the last 15 seconds before idle
      // actually triggers — amber for the first 10 of those, switching to a
      // more urgent red for the final 5 — instead of the steady green, so
      // it's a heads-up rather than indistinguishable from normal ticking.
      // Naturally clears the moment real activity resets idleSeconds, no
      // separate timeout to manage.
      const secondsUntilIdle = idleThresholdSec - idleSeconds;
      const miniTimerStatus =
        secondsUntilIdle > 0 && secondsUntilIdle <= 5
          ? "idle-critical"
          : secondsUntilIdle > 5 && secondsUntilIdle <= 15
            ? "idle-warning"
            : "running";
      const taskInfo = findTaskInfo(projectGroups, running.taskId);
      window.timeStaff.miniTimer.update({
        taskName: taskInfo?.title ?? running.task?.title ?? "—",
        projectName: taskInfo?.projectName ?? running.task?.project.name ?? "—",
        // Same total the main window's status bar shows (today's total for
        // this task, plus the live session) — not just this session's own
        // elapsed time, which used to make the widget's clock disagree
        // with the app.
        elapsedSeconds: (taskInfo?.todaySeconds ?? 0) + tickElapsed,
        status: miniTimerStatus,
      });
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
        // Read fresh each time (not captured when the timer started) so a
        // position picked in Settings applies to the very next screenshot.
        window.timeStaff.notifyScreenshotCaptured(getScreenshotAlertPosition());
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

  // Shows the mini-timer widget whenever a genuinely new/different entry
  // starts running — covers handleSwitchTask, handleMiniTimerResume, and
  // the idle dialog's "no, discard and restart" path uniformly, since all
  // three end in a fresh `running.id`. Deliberately keyed on just the id,
  // not `running` itself, so it doesn't re-fire on every tick. It never
  // hides the widget on its own — pausing also sets `running` to null, but
  // the widget has to stay up with a Resume button, not disappear, so
  // hiding is always an explicit call at the specific places that mean it
  // (Stop, app close, idle dialog appearing).
  useEffect(() => {
    if (!running) return;
    const taskInfo = findTaskInfo(projectGroups, running.taskId);
    window.timeStaff.miniTimer.show({
      taskName: taskInfo?.title ?? running.task?.title ?? "—",
      projectName: taskInfo?.projectName ?? running.task?.project.name ?? "—",
      elapsedSeconds: (taskInfo?.todaySeconds ?? 0) + elapsedSeconds,
      status: "running",
    });
  }, [running?.id]);

  // Closing the main window is the app's only "I'm done" signal — main.ts
  // defers the actual close until this confirms, giving the stop request
  // time to land before the window (and its auth/API context) disappears.
  useEffect(() => {
    return window.timeStaff.onBeforeClose(async () => {
      if (running) {
        try {
          await stopTimer(running.id);
        } catch {
          // Best-effort — the window is closing regardless.
        }
      }
      window.timeStaff.confirmReadyToClose();
    });
  }, [running]);

  // The floating mini-timer widget's pause/resume button has no logic of
  // its own — reported back through main exactly like the idle-alert
  // window's choices are. "dismiss" (its X) is handled entirely in
  // main.ts and never reaches here, since it's a pure visibility change
  // with no timer-state consequence.
  useEffect(() => {
    return window.timeStaff.miniTimer.onAction((action) => {
      if (action === "pause") handleMiniTimerPause();
      else if (action === "resume") handleMiniTimerResume();
    });
  }, [running, pausedTask, projectGroups, elapsedSeconds]);

  // Pausing from the widget stops the current entry — its time is folded
  // into the task's total exactly like a full Stop — but keeps the widget
  // itself visible with a Resume button, instead of disappearing like a
  // real Stop does. The displayed clock is deliberately left as-is (not
  // reset to 0): frozen at wherever it was when paused, so resuming reads
  // as a continuation rather than a restart.
  async function handleMiniTimerPause() {
    if (!running) return;
    setBusy(true);
    setError(null);
    const taskId = running.taskId;
    const fallbackTask = running.task;
    try {
      await stopTimer(running.id);
      foldElapsedIntoTask(taskId, elapsedSeconds);
      const taskInfo = findTaskInfo(projectGroups, taskId);
      const paused = {
        id: taskId,
        title: taskInfo?.title ?? fallbackTask?.title ?? "—",
        projectName: taskInfo?.projectName ?? fallbackTask?.project.name ?? "—",
      };
      setPausedTask(paused);
      setRunning(null);
      setSessionElapsedBaseSec(0);
      window.timeStaff.miniTimer.update({
        taskName: paused.title,
        projectName: paused.projectName,
        // taskInfo.todaySeconds is the pre-fold total (the projectGroups
        // state update from foldElapsedIntoTask above hasn't landed yet at
        // this point) — adding this session's elapsedSeconds here gives
        // the same post-fold total without waiting a render for it.
        elapsedSeconds: (taskInfo?.todaySeconds ?? 0) + elapsedSeconds,
        status: "paused",
      });
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't pause the timer."));
    } finally {
      setBusy(false);
    }
  }

  // Resuming starts a fresh entry for the same task — the widget's "show"
  // effect above picks this up automatically once `running` gets a new id,
  // and the displayed total stays correct because the paused segment is
  // already folded into the task's todaySeconds.
  async function handleMiniTimerResume() {
    if (!pausedTask) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await startTimer(pausedTask.id);
      setRunning(entry);
      setSessionElapsedBaseSec(0);
      setPausedTask(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't resume the timer."));
    } finally {
      setBusy(false);
    }
  }

  async function resolveIdleStop(idleSeconds: number) {
    if (!running) return;
    const idleSince = new Date(Date.now() - idleSeconds * 1000);
    try {
      await stopTimer(running.id, idleSince.toISOString());
    } catch {
      // Nothing more we can do here — leave it to the user to stop manually.
    }
    // elapsedSeconds is exactly the worked duration here — the clock was
    // frozen at the pre-idle value the moment idle was detected, which is
    // the same instant idleSince truncates the entry to server-side.
    foldElapsedIntoTask(running.taskId, elapsedSeconds);
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
      // Approximate: elapsedSeconds is frozen at the pre-idle value, but
      // this branch tells the server to count the idle+dialog stretch as
      // worked too (no idleSince truncation), so the true duration is
      // slightly higher than this. Close enough for the live display; the
      // next Refresh reconciles it exactly from the server.
      foldElapsedIntoTask(running.taskId, elapsedSeconds);
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
      // The same entry just kept running the whole time — running.id never
      // changes here, so nothing else would naturally bring the mini-timer
      // widget back after setIdleAlertBoth hid it; show it explicitly.
      const taskInfo = findTaskInfo(projectGroups, running.taskId);
      window.timeStaff.miniTimer.show({
        taskName: taskInfo?.title ?? running.task?.title ?? "—",
        projectName: taskInfo?.projectName ?? running.task?.project.name ?? "—",
        elapsedSeconds: (taskInfo?.todaySeconds ?? 0) + elapsedSeconds,
        status: "running",
      });
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
  }, [idleAlert, running, projectGroups]);

  async function handleSwitchTask(taskId: string) {
    // Clicking the task that's already running is how you stop it — matches
    // Hubstaff's play/stop toggle instead of silently doing nothing, which
    // was the actual bug behind "I can't tell if the task is on or off".
    if (running?.taskId === taskId) {
      await handleStop();
      return;
    }
    // Switching straight to a different task while one is already running
    // — the backend auto-stops the old entry server-side, but the old
    // task's just-finished session still needs folding into local state
    // here too, or it'd vanish from the display exactly like the
    // plain-Stop case until the next Refresh.
    if (running) {
      foldElapsedIntoTask(running.taskId, elapsedSeconds);
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entry = await startTimer(taskId);
      setRunning(entry);
      setSessionElapsedBaseSec(0);
      // Starting a genuinely different task while something else was
      // paused abandons that pause — its time is already safely folded
      // into its own task's total, so there's nothing left to lose here.
      setPausedTask(null);
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
      foldElapsedIntoTask(running.taskId, elapsedSeconds);
      setRunning(null);
      setElapsedSeconds(0);
      setSessionElapsedBaseSec(0);
      setPausedTask(null);
      window.timeStaff.miniTimer.hide();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't stop the timer."));
    } finally {
      setBusy(false);
    }
  }

  // Searching surfaces matching tasks across every project at once (shown
  // grouped by project on the right) instead of requiring you to first pick
  // the right project from the sidebar.
  const isSearching = search.trim().length > 0;
  const searchResultGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
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

  // The right panel always shows exactly one project's task list — never a
  // duplicate of everything already in the sidebar. It defaults to whichever
  // project currently has the running task, then falls back to the first
  // project, so landing on the app always shows something relevant.
  const selectedProject =
    projectGroups.find((g) => g.id === selectedProjectId) ??
    projectGroups.find((g) => g.tasks.some((t) => t.id === running?.taskId)) ??
    projectGroups[0] ??
    null;

  // A project's stored todaySeconds only covers already-completed sessions
  // — it needs the live elapsedSeconds added on top while one of its tasks
  // is the one currently running, or the project total (sidebar row and
  // the task panel's header) just sits frozen at whatever it was on load
  // instead of ticking with the clock.
  function liveProjectSeconds(group: ProjectGroup): number {
    const isRunningHere = !!running && group.tasks.some((t) => t.id === running.taskId);
    return group.todaySeconds + (isRunningHere ? elapsedSeconds : 0);
  }

  if (bootstrapping) {
    return (
      <>
        <TitleBar />
        <div className="boot-screen">
          <div className="spinner" />
        </div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <TitleBar />
        <Login onSuccess={handleLoginSuccess} />
      </>
    );
  }

  if (view === "settings") {
    return (
      <>
        <TitleBar />
        <SettingsPage onBack={() => setView("home")} />
      </>
    );
  }

  const runningRowSeconds = running ? currentTask ? currentTask.todaySeconds + elapsedSeconds : elapsedSeconds : 0;

  return (
    <>
    <TitleBar />
    <div className="app-shell">
      {/* Fixed-height status bar, always rendered — idle or running, it's the
          same element with different content, never mounted/unmounted. That
          was the actual cause of the "dancing" layout: a conditionally
          rendered timer strip used to appear/disappear and shove everything
          below it up and down every time a timer started or stopped. */}
      <div className="status-bar">
        <div className="status-bar-center">
          <span
            className={`status-pill ${running ? "running" : "idle"}`}
            title={`Idle time is discarded after ${formatDurationLabel(idleThresholdSec)} of inactivity`}
          >
            <span className="status-pill-dot" />
            {running ? "Running" : "Idle"}
          </span>
          <span className="status-clock">{formatClock(runningRowSeconds)}</span>
          <span className="status-divider" />
          <span className="status-field">
            <span className="status-field-label">Project</span>
            <span className="status-field-value">{currentTask?.projectName ?? "No project selected"}</span>
          </span>
          <span className="status-divider status-divider-wide" />
          <span className="status-field">
            <span className="status-field-label">Task</span>
            <span className="status-field-value">{currentTask?.title ?? "No task selected"}</span>
          </span>
        </div>
        <button
          className="status-stop-btn"
          onClick={handleStop}
          disabled={!running || busy}
          title="Stop timer"
        >
          <span className="status-stop-icon" />
          Stop
        </button>
      </div>

      <div className="app-body">
        <aside className="sidebar">
          <label className="sidebar-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <div className="sidebar-projects-head">
            <span className="sidebar-projects-label">Projects</span>
            <span className="sidebar-projects-count">{projectGroups.length}</span>
          </div>

          <div className="sidebar-projects">
            {loadingWorkspace ? (
              <p className="sidebar-empty">Loading your projects…</p>
            ) : projectGroups.length === 0 ? (
              <p className="sidebar-empty">No tasks assigned to you yet.</p>
            ) : (
              projectGroups
                .filter((g) => !isSearching || searchResultGroups.some((r) => r.id === g.id))
                .map((group) => (
                  <button
                    key={group.id}
                    className={`sidebar-project-row ${group.id === selectedProject?.id ? "selected" : ""}`}
                    onClick={() => setSelectedProjectId(group.id)}
                  >
                    <span className="sidebar-project-dot" style={{ backgroundColor: colorForProject(group.id) }} />
                    <span className="sidebar-project-name">{group.name}</span>
                    <span className="sidebar-project-time">{formatClock(liveProjectSeconds(group))}</span>
                    <svg className="sidebar-project-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                ))
            )}
          </div>
        </aside>

        <main className="main-content">
          {error && <p className="banner error">{error}</p>}
          {notice && <p className="banner notice">{notice}</p>}

          {isSearching ? (
            <div className="project-card">
              <div className="project-card-header">
                <span className="project-card-icon" style={{ background: "#6b7280" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <div className="project-card-heading">
                  <h2>Search results</h2>
                  <p>{searchResultGroups.reduce((n, g) => n + g.tasks.length, 0)} matching tasks</p>
                </div>
              </div>
              <div className="task-table">
                {searchResultGroups.length === 0 ? (
                  <p className="sidebar-empty">Nothing matches your search.</p>
                ) : (
                  searchResultGroups.map((group) =>
                    group.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        isRunning={task.id === running?.taskId}
                        elapsedSeconds={elapsedSeconds}
                        onClick={() => handleSwitchTask(task.id)}
                        disabled={busy}
                      />
                    )),
                  )
                )}
              </div>
            </div>
          ) : !selectedProject ? (
            <div className="project-card">
              <p className="sidebar-empty">
                {loadingWorkspace ? "Loading your projects…" : "No tasks assigned to you yet — pick one up on the web app to start tracking."}
              </p>
            </div>
          ) : (
            <div className="project-card">
              <div className="project-card-header">
                <span className="project-card-icon" style={{ background: colorForProject(selectedProject.id) }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                  </svg>
                </span>
                <div className="project-card-heading">
                  <h2>{selectedProject.name}</h2>
                  <p>
                    {selectedProject.tasks.length} {selectedProject.tasks.length === 1 ? "task" : "tasks"}
                    {" • "}
                    {formatClock(liveProjectSeconds(selectedProject))} today
                  </p>
                </div>
                <button
                  className="project-card-menu"
                  onClick={() => window.timeStaff.openExternal(`${WEB_DASHBOARD_URL}/projects/${selectedProject.id}`)}
                  title="Open this project on the web dashboard"
                  aria-label="Open this project on the web dashboard"
                >
                  <span className="project-card-menu-dot" />
                  <span className="project-card-menu-dot" />
                  <span className="project-card-menu-dot" />
                </button>
              </div>
              <div className="task-table">
                {selectedProject.tasks.length === 0 ? (
                  <p className="sidebar-empty">This project has no tasks assigned to you.</p>
                ) : (
                  selectedProject.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      isRunning={task.id === running?.taskId}
                      elapsedSeconds={elapsedSeconds}
                      onClick={() => handleSwitchTask(task.id)}
                      disabled={busy}
                    />
                  ))
                )}
              </div>
            </div>
          )}

        </main>
      </div>

      {/* Global bottom bar — full-width, same fixed height and floating-card
          treatment as the status bar up top, so the four regions (status
          bar, sidebar, task panel, bottom bar) read as a consistent grid
          with equal gaps rather than the account block being just one more
          thing bolted onto the bottom of the sidebar. */}
      <div className="bottom-bar">
        <div className="bottom-bar-user-wrap">
          <button className="bottom-bar-user" onClick={() => setUserMenuOpen((v) => !v)}>
            <span className="sidebar-avatar">
              {`${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase()}
            </span>
            <span className="bottom-bar-user-info">
              <span className="bottom-bar-user-name">{user.firstName} {user.lastName}</span>
              <span className="bottom-bar-user-email">{user.email}</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <path d={userMenuOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
            </svg>
          </button>
          {userMenuOpen && (
            <div className="bottom-bar-user-menu">
              <button
                className="sidebar-user-menu-item"
                onClick={() => window.timeStaff.openExternal(WEB_DASHBOARD_URL)}
              >
                Open web dashboard
              </button>
              <button
                className="sidebar-user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  setView("settings");
                }}
              >
                Settings
              </button>
              <button className="sidebar-user-menu-item danger" onClick={handleLogout}>
                Log out
              </button>
            </div>
          )}
        </div>

        <span className="status-bar-spacer" />

        {lastUpdatedAt && (
          <span className="bottom-bar-last-updated">Last updated at: {formatLastUpdated(lastUpdatedAt)}</span>
        )}

        <button
          className="bottom-bar-refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing || loadingWorkspace}
          title="Refresh projects and tasks"
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
          Refresh
        </button>
      </div>
    </div>
    </>
  );
}

// A custom-drawn replacement for the native OS title bar (see the
// `titleBarStyle: 'hidden'` window option in main.ts) — the native one
// can't be restyled at all, so to make it match the app's background,
// height and font, the app draws its own draggable strip here, including
// its own minimize/maximize/close buttons (rather than Electron's
// titleBarOverlay ones, whose minimize/maximize hover state Windows
// renders too faintly to see against a light background — only the close
// button's hover is hard-coded red by the OS regardless).
function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  // macOS always draws its own traffic-light buttons in 'hidden' mode
  // regardless of anything we do — rendering a second set here would just
  // duplicate/conflict with them.
  const showControls = window.timeStaff.platform !== "darwin";

  useEffect(() => {
    if (!showControls) return;
    window.timeStaff.windowControls.isMaximized().then(setIsMaximized);
    return window.timeStaff.windowControls.onMaximizedChanged(setIsMaximized);
  }, [showControls]);

  return (
    <div className="title-bar" onDoubleClick={() => showControls && window.timeStaff.windowControls.maximizeToggle()}>
      <svg className="title-bar-mark" viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#4F46E5" />
        <rect x="13.5" y="3" width="5" height="3" rx="1.2" fill="#fff" />
        <rect x="20.3" y="5" width="4" height="2.6" rx="1" fill="#fff" transform="rotate(45 22.3 6.3)" />
        <circle cx="16" cy="18.5" r="10" fill="none" stroke="#fff" strokeWidth="2.3" />
        <line x1="16" y1="18.5" x2="16" y2="12.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="16" y1="18.5" x2="20" y2="18.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
      <span className="title-bar-name">TimeStaff</span>
      {showControls && (
        <div className="title-bar-controls">
          <button
            className="title-bar-btn"
            onClick={() => window.timeStaff.windowControls.minimize()}
            title="Minimize"
            aria-label="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className="title-bar-btn"
            onClick={() => window.timeStaff.windowControls.maximizeToggle()}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                <rect x="2" y="0.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
                <path d="M0.5 2.5V9.5H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            )}
          </button>
          <button
            className="title-bar-btn title-bar-btn-close"
            onClick={() => window.timeStaff.windowControls.close()}
            title="Close"
            aria-label="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
              <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// One row of the selected project's task table. Fixed height regardless of
// whether the task has a due date, so switching projects never makes rows
// jump to a different size depending on their content.
function TaskRow({
  task,
  isRunning,
  elapsedSeconds,
  onClick,
  disabled,
}: {
  task: MyTask;
  isRunning: boolean;
  elapsedSeconds: number;
  onClick: () => void;
  disabled: boolean;
}) {
  const seconds = isRunning ? task.todaySeconds + elapsedSeconds : task.todaySeconds;
  // The task's own description is the most useful second line when it has
  // one; otherwise fall back to its due date so the row keeps a consistent
  // two-line height either way.
  const overdue = isOverdue(task.dueDate);
  const subtitle =
    task.description?.trim() ||
    (overdue ? "Missed due date" : task.dueDate ? `Due ${formatDueDate(task.dueDate)}` : "No due date");
  const subtitleIsOverdueWarning = !task.description?.trim() && overdue;

  return (
    <div className={`task-table-row ${isRunning ? "running" : ""}`}>
      <span className={`task-radio ${isRunning ? "running" : ""}`} />
      <span className="task-table-info">
        <span className="task-table-title">{task.title}</span>
        <span className={`task-table-subtitle ${subtitleIsOverdueWarning ? "overdue" : ""}`}>{subtitle}</span>
      </span>
      <span className="task-table-time">{formatClock(seconds)}</span>
      <span className={`task-status-pill ${isRunning ? "running" : "idle"}`}>{isRunning ? "Running" : "Idle"}</span>
      <button
        className={`task-toggle-btn ${isRunning ? "running" : ""}`}
        onClick={onClick}
        disabled={disabled}
        title={isRunning ? "Stop" : "Start"}
        aria-label={isRunning ? "Stop" : "Start"}
      >
        {isRunning ? <span className="task-toggle-stop" /> : <span className="task-toggle-play" />}
      </button>
      <button
        className="task-row-menu"
        onClick={() => window.timeStaff.openExternal(`${WEB_DASHBOARD_URL}/tasks/${task.id}`)}
        title="Open task on web dashboard"
        aria-label="Open task on web dashboard"
      >
        <span className="task-row-menu-dot" />
        <span className="task-row-menu-dot" />
        <span className="task-row-menu-dot" />
      </button>
    </div>
  );
}
