import axios, { type InternalAxiosRequestConfig } from "axios";

// LAN IP, not "localhost" — a packaged build running on another machine on
// the network needs to reach the backend on whichever PC is actually
// running it. Revert to "http://localhost:5000" for normal single-machine
// dev/testing.
export const api = axios.create({
  baseURL: "http://10.0.10.61:5000",
  headers: { "X-Client-Type": "desktop" },
  // Without a timeout a half-dead connection (wifi that is "connected" but
  // goes nowhere) leaves a request hanging forever — and with it the timer
  // action, or the whole offline queue, waiting behind it.
  timeout: 20_000,
});
// No hardcoded Content-Type default — axios infers it per request from the
// payload shape (application/json for a plain object, multipart/form-data
// with the correct boundary for a FormData body, used by the screenshot
// upload below). Forcing application/json here would have silently broken
// multipart uploads by overriding the boundary axios needs to set itself.

// Thrown instead of a 401 when the access token expired and the refresh call
// itself couldn't reach the server — that's "offline", not "signed out", so
// it must neither log the user out nor be treated as a rejected request.
export class BackendUnreachableError extends Error {
  constructor() {
    super("Couldn't reach the TimeStaff backend");
    this.name = "BackendUnreachableError";
  }
}

// True for failures worth retrying later (no response at all, timeouts, 5xx,
// 408/429) as opposed to the server having looked at the request and said
// no. The offline queue keeps the former and drops the latter.
export function isTransientError(error: unknown): boolean {
  if (error instanceof BackendUnreachableError) return true;
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status === undefined) return true;
  return status >= 500 || status === 408 || status === 429;
}

// Whether the backend answered the last request. Drives the "offline"
// banner; navigator.onLine alone can't say, since a LAN backend can be
// down while the machine itself is "online".
let reachable = true;
const reachabilityListeners = new Set<() => void>();
function setReachable(value: boolean) {
  if (reachable === value) return;
  reachable = value;
  reachabilityListeners.forEach((cb) => cb());
}
export function isBackendReachable() {
  return reachable;
}
// A cheap request whose only job is to let the response interceptor above
// notice the backend is back (any HTTP answer, even a 404, counts). Without
// it, "offline" would only clear once the user did something.
export function probeBackend(): Promise<void> {
  return api
    .get("/", { timeout: 5000 })
    .then(() => undefined)
    .catch(() => undefined);
}
export function subscribeReachability(cb: () => void) {
  reachabilityListeners.add(cb);
  return () => reachabilityListeners.delete(cb);
}

// The backend's error responses carry a real, specific message (e.g. "You
// do not have permission...", "Time can only be tracked on a task with no
// subtasks") — surface that instead of a generic "something went wrong",
// so failures are actually diagnosable from the UI.
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: string } | undefined)?.message;
    if (message) return message;
    if (error.code === "ERR_NETWORK") return "Couldn't reach the TimeStaff backend — is it running?";
  }
  return fallback;
}

// --- Access token + auto-refresh plumbing ---------------------------------
// The access token lives in memory only (same principle as the web app's
// Zustand store) — never written to disk. The long-lived refresh token is
// the only thing persisted, and only via main-process safeStorage (see
// preload.ts / main.ts), never touched by this module directly.

let accessToken: string | null = null;
export function setAccessToken(token: string | null) {
  accessToken = token;
}

// Set by App once, so this module can trigger a session-expired flow
// (clear stored refresh token, show the login screen) without importing
// React state directly.
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return config;
});

// Three outcomes, not two: "the server refused this refresh token" means the
// session is genuinely over, but "couldn't reach the server" just means we're
// offline — treating the latter as the former would sign the user out (and
// wipe their refresh token) every time the network blipped while a token
// happened to be expiring.
type RefreshResult =
  | { status: "ok"; accessToken: string }
  | { status: "rejected" }
  | { status: "unreachable" };

let refreshInFlight: Promise<RefreshResult> | null = null;

async function tryRefresh(): Promise<RefreshResult> {
  const storedRefreshToken = await window.timeStaff.auth.getRefreshToken();
  if (!storedRefreshToken) return { status: "rejected" };
  try {
    const res = await axios.post<{ data: { accessToken: string; refreshToken?: string } }>(
      `${api.defaults.baseURL}/auth/refresh`,
      { refreshToken: storedRefreshToken },
      { headers: { "X-Client-Type": "desktop" }, timeout: 20_000 },
    );
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = res.data.data;
    setAccessToken(newAccessToken);
    if (newRefreshToken) await window.timeStaff.auth.setRefreshToken(newRefreshToken);
    setReachable(true);
    return { status: "ok", accessToken: newAccessToken };
  } catch (error) {
    return isTransientError(error) ? { status: "unreachable" } : { status: "rejected" };
  }
}

api.interceptors.response.use(
  (res) => {
    setReachable(true);
    return res;
  },
  async (error) => {
    // Any answer from the server — even an error status — proves it's up;
    // only "no response at all" (or a 5xx from a proxy in front of it) means
    // unreachable.
    if (axios.isAxiosError(error)) {
      setReachable(error.response !== undefined && error.response.status < 502);
    }
    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    if (error.response?.status === 401 && originalRequest && !originalRequest._retried) {
      originalRequest._retried = true;
      // Coalesce concurrent 401s into a single refresh call.
      refreshInFlight ??= tryRefresh().finally(() => {
        refreshInFlight = null;
      });
      const result = await refreshInFlight;
      if (result.status === "ok") {
        originalRequest.headers.set("Authorization", `Bearer ${result.accessToken}`);
        return api.request(originalRequest);
      }
      if (result.status === "unreachable") {
        setReachable(false);
        return Promise.reject(new BackendUnreachableError());
      }
      await window.timeStaff.auth.clearRefreshToken();
      setAccessToken(null);
      onSessionExpired?.();
    }
    return Promise.reject(error);
  },
);

// --- Auth -------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  organizationId: string | null;
  role: string | null;
}

export async function login(email: string, password: string) {
  const res = await api.post<{ data: { accessToken: string; refreshToken?: string; user: AuthUser } }>(
    "/auth/login",
    { email, password },
  );
  const { accessToken: token, refreshToken, user } = res.data.data;
  setAccessToken(token);
  if (refreshToken) await window.timeStaff.auth.setRefreshToken(refreshToken);
  return user;
}

// "offline" = a refresh token is stored but the backend couldn't be reached to
// confirm it — the caller can fall back to the cached workspace instead of
// bouncing a signed-in user to the login screen with no network.
export async function restoreSession(): Promise<AuthUser | null | "offline"> {
  const result = await tryRefresh();
  if (result.status === "unreachable") return "offline";
  if (result.status === "rejected") return null;
  try {
    return await getMe();
  } catch (error) {
    return isTransientError(error) ? "offline" : null;
  }
}

export async function getMe(): Promise<AuthUser> {
  return (await api.get<{ data: AuthUser }>("/auth/me")).data.data;
}

export async function logout() {
  setAccessToken(null);
  await window.timeStaff.auth.clearRefreshToken();
}

// --- Projects & tasks ---------------------------------------------------------

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string;
  assigneeId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedMinutes: number | null;
  subtasks?: Task[];
}

export async function fetchProjects(): Promise<Project[]> {
  return (await api.get<{ data: Project[] }>("/projects")).data.data;
}

export async function fetchProjectTasks(projectId: string): Promise<Task[]> {
  return (await api.get<{ data: Task[] }>(`/projects/${projectId}/tasks`)).data.data;
}

// --- Timer -------------------------------------------------------------------

export interface RunningTimeEntry {
  id: string;
  taskId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  task?: { id: string; title: string; project: { id: string; name: string } };
}

export async function fetchCurrentTimer(): Promise<RunningTimeEntry | null> {
  return (await api.get<{ data: RunningTimeEntry | null }>("/time-entries/me/current")).data.data;
}

// The optional id/startedAt are what make a start replayable from the offline
// outbox: the client picks the entry's id (the backend uses it as the row id,
// so a retry returns the same entry instead of a duplicate) and the moment
// the user actually pressed start.
export async function startTimer(
  taskId: string,
  opts: { id?: string; startedAt?: string } = {},
): Promise<RunningTimeEntry> {
  return (await api.post<{ data: RunningTimeEntry }>(`/tasks/${taskId}/time-entries/start`, opts)).data.data;
}

// `timeoutMs` lets a caller that can't wait (the window is closing) give up
// early and fall back to queueing the stop instead.
export async function stopTimer(entryId: string, endedAt?: string, timeoutMs?: number): Promise<RunningTimeEntry> {
  return (
    await api.post<{ data: RunningTimeEntry }>(
      `/time-entries/${entryId}/stop`,
      endedAt ? { endedAt } : {},
      timeoutMs ? { timeout: timeoutMs } : undefined,
    )
  ).data.data;
}

// --- Screenshots --------------------------------------------------------------

// Backend gates the whole feature behind the org's plan (`screenshots`
// entitlement, Growth/Enterprise only) — a 402 here means the org's plan
// doesn't include it. Without `meta` the screenshot attaches to the task's
// running timer; with it (the offline outbox replaying later) it names the
// entry, capture time and an idempotency id.
export async function uploadScreenshot(
  taskId: string,
  blob: Blob,
  meta?: { id: string; timeEntryId: string; takenAt: string },
): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "screenshot.png");
  if (meta) {
    form.append("id", meta.id);
    form.append("timeEntryId", meta.timeEntryId);
    form.append("takenAt", meta.takenAt);
  }
  // Roomier than the default: a full-resolution PNG over a slow link.
  await api.post(`/tasks/${taskId}/screenshots`, form, { timeout: 90_000 });
}

export function isEntitlementError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 402;
}

// --- Activity -----------------------------------------------------------------

// Keyboard/mouse activity is reported separately from screenshots (own
// endpoint, no screenshots entitlement) — just counts of seconds, never which
// keys or where.
export interface ActivitySamplePayload {
  id: string;
  timeEntryId: string;
  activeSec: number;
  totalSec: number;
  sampledAt: string;
}

export async function reportActivity(taskId: string, sample: ActivitySamplePayload): Promise<void> {
  await api.post(`/tasks/${taskId}/activity-samples`, sample);
}

export interface TimeEntry {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
}

// Used to compute today's tracked total per project/task for the sidebar —
// mirrors the same range-filtered endpoint the web timeline page uses.
export async function fetchMyTimeEntries(from: string, to: string): Promise<TimeEntry[]> {
  return (await api.get<{ data: TimeEntry[] }>("/time-entries", { params: { from, to } })).data.data;
}

// --- Org tracking settings ----------------------------------------------------

export interface TrackingSettings {
  idleThresholdSec: number;
  screenshotIntervalSec: number;
}

export async function fetchTrackingSettings(organizationId: string): Promise<TrackingSettings> {
  return (await api.get<{ data: TrackingSettings }>(`/organizations/${organizationId}/tracking-settings`)).data.data;
}
