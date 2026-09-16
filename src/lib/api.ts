import axios, { type InternalAxiosRequestConfig } from "axios";

export const api = axios.create({
  baseURL: "http://localhost:5000",
  headers: { "X-Client-Type": "desktop" },
});
// No hardcoded Content-Type default — axios infers it per request from the
// payload shape (application/json for a plain object, multipart/form-data
// with the correct boundary for a FormData body, used by the screenshot
// upload below). Forcing application/json here would have silently broken
// multipart uploads by overriding the boundary axios needs to set itself.

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

let refreshInFlight: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  const storedRefreshToken = await window.timeStaff.auth.getRefreshToken();
  if (!storedRefreshToken) return null;
  try {
    const res = await axios.post<{ data: { accessToken: string; refreshToken?: string } }>(
      `${api.defaults.baseURL}/auth/refresh`,
      { refreshToken: storedRefreshToken },
      { headers: { "X-Client-Type": "desktop" } },
    );
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = res.data.data;
    setAccessToken(newAccessToken);
    if (newRefreshToken) await window.timeStaff.auth.setRefreshToken(newRefreshToken);
    return newAccessToken;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    if (error.response?.status === 401 && originalRequest && !originalRequest._retried) {
      originalRequest._retried = true;
      // Coalesce concurrent 401s into a single refresh call.
      refreshInFlight ??= tryRefresh().finally(() => {
        refreshInFlight = null;
      });
      const newAccessToken = await refreshInFlight;
      if (newAccessToken) {
        originalRequest.headers.set("Authorization", `Bearer ${newAccessToken}`);
        return api.request(originalRequest);
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

export async function restoreSession(): Promise<AuthUser | null> {
  const newAccessToken = await tryRefresh();
  if (!newAccessToken) return null;
  try {
    return await getMe();
  } catch {
    return null;
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
  status: string;
  assigneeId: string | null;
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

export async function startTimer(taskId: string): Promise<RunningTimeEntry> {
  return (await api.post<{ data: RunningTimeEntry }>(`/tasks/${taskId}/time-entries/start`)).data.data;
}

export async function stopTimer(entryId: string, endedAt?: string): Promise<RunningTimeEntry> {
  return (
    await api.post<{ data: RunningTimeEntry }>(`/time-entries/${entryId}/stop`, endedAt ? { endedAt } : {})
  ).data.data;
}

// --- Screenshots --------------------------------------------------------------

// Backend requires an active running timer on the task and gates the whole
// feature behind the org's plan (`screenshots` entitlement, Growth/
// Enterprise only) — a 402 here means the org's plan doesn't include it.
export async function uploadScreenshot(taskId: string, blob: Blob): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "screenshot.png");
  await api.post(`/tasks/${taskId}/screenshots`, form);
}

export function isEntitlementError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 402;
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
