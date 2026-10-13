import type { AuthUser } from "./api";

// The last workspace the backend gave us (who's signed in, their tasks, the
// org's tracking settings). It exists so the app can still open and start a
// timer when there's no network — it's a convenience copy, never a source of
// truth: the first successful load replaces it, and nothing in it (notably
// not "what's running") is trusted over the backend or the outbox.

interface Snapshot<T> {
  user: AuthUser;
  data: T;
  savedAt: string;
}

export async function saveWorkspaceCache<T>(user: AuthUser, data: T): Promise<void> {
  try {
    const snapshot: Snapshot<T> = { user, data, savedAt: new Date().toISOString() };
    await window.timeStaff.storage.saveWorkspaceCache(JSON.stringify(snapshot));
  } catch {
    // A missed cache write only costs offline start-up, never correctness.
  }
}

// Optionally pinned to a user id, so one person's cached tasks are never
// shown to whoever signs in next on the same machine.
export async function loadWorkspaceCache<T>(forUserId?: string): Promise<Snapshot<T> | null> {
  try {
    const raw = await window.timeStaff.storage.loadWorkspaceCache();
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as Snapshot<T>;
    if (!snapshot?.user?.id) return null;
    if (forUserId && snapshot.user.id !== forUserId) return null;
    return snapshot;
  } catch {
    return null;
  }
}
