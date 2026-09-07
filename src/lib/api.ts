import axios from "axios";

// Hardcoded for local testing — this becomes a real setting once the app
// needs to point at anything other than your own machine.
export const api = axios.create({
  baseURL: "http://localhost:3000",
  headers: { "Content-Type": "application/json" },
});

export interface TaskOption {
  id: string;
  label: string;
}

export interface Project {
  id: string;
  name: string;
  color: string | null;
  totalSeconds: number;
  tasks: { id: string; name: string; totalSeconds: number }[];
}

export interface RunningTimer {
  id: string;
  taskId: string;
  startedAt: string;
  durationSeconds: number;
  task: { id: string; name: string; project: { id: string; name: string; color: string | null } };
}

export async function fetchProjects(): Promise<Project[]> {
  return (await api.get<Project[]>("/projects")).data;
}

export async function fetchCurrentTimer(): Promise<RunningTimer | null> {
  const res = await api.get<RunningTimer | "">("/timer/current");
  // Empty body (nothing running) comes back as "" — normalize to null.
  return res.data || null;
}

export async function startTimer(taskId: string): Promise<RunningTimer> {
  return (await api.post<RunningTimer>("/timer/start", { taskId })).data;
}

export async function stopTimer(endedAt?: string): Promise<void> {
  await api.post("/timer/stop", endedAt ? { endedAt } : {});
}

export async function tickTimer(): Promise<{ durationSeconds: number }> {
  return (await api.patch<{ durationSeconds: number }>("/timer/tick")).data;
}

export interface AppSettings {
  idleTimeoutMinutes: number;
}

export async function fetchSettings(): Promise<AppSettings> {
  return (await api.get<AppSettings>("/settings")).data;
}
