import axios from "axios";
import {
  isBackendReachable,
  isEntitlementError,
  isTransientError,
  probeBackend,
  reportActivity,
  startTimer as apiStartTimer,
  stopTimer as apiStopTimer,
  subscribeReachability,
  uploadScreenshot,
  type RunningTimeEntry,
} from "./api";

// Offline resilience: every write that matters for logged time goes through
// here. When the backend is reachable it's sent straight away, exactly as
// before. When it isn't (or a send fails transiently), the operation is
// persisted to disk and replayed, in order, once the backend answers again.
//
// Replays are safe to repeat because every record carries a client-generated
// UUID that the backend uses as the row id (or checks for) — a retry after a
// timed-out-but-actually-successful request returns the original, never a
// duplicate.

export type OutboxOp =
  | { type: "start"; opId: string; userId: string; entryId: string; taskId: string; startedAt: string }
  | { type: "stop"; opId: string; userId: string; entryId: string; endedAt: string }
  | {
      type: "screenshot";
      opId: string;
      userId: string;
      // Also the name of the PNG blob on disk and the backend row id.
      id: string;
      entryId: string;
      taskId: string;
      takenAt: string;
    }
  | {
      type: "activity";
      opId: string;
      userId: string;
      id: string;
      entryId: string;
      taskId: string;
      activeSec: number;
      totalSec: number;
      sampledAt: string;
    };

// Time entries are the product; screenshots are large and optional. Cap how
// many pile up on disk during a long outage rather than fill it — the oldest
// are kept (they’re the ones the entry windows still cover).
const MAX_QUEUED_SCREENSHOTS = 200;
const MAX_QUEUED_ACTIVITY = 5000;
const AUTO_SYNC_INTERVAL_MS = 10_000;

let ops: OutboxOp[] = [];
let loaded = false;
let currentUserId: string | null = null;
let draining: Promise<void> | null = null;
let autoSyncStarted = false;
// Ops the backend refused for good (not a network problem) since this
// session began — surfaced once so a silent drop isn't invisible.
let droppedCount = 0;
const droppedReasons = new Map<string, string>();

const listeners = new Set<() => void>();
function notify() {
  statusVersion += 1;
  listeners.forEach((cb) => cb());
}
let statusVersion = 0;

export function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function persist() {
  try {
    await window.timeStaff.storage.saveOutbox(JSON.stringify({ version: 1, ops }));
  } catch (err) {
    // The in-memory queue still works for this session; only a crash before
    // the next successful save would lose it.
    console.warn("Couldn't persist the offline outbox", err);
  }
}

// --- Public: lifecycle ----------------------------------------------------------

// Loads whatever a previous session left on disk and starts background
// syncing. Called once the signed-in user is known; safe to call again (e.g.
// after logging in as someone else — ops stay tied to the user that made them).
export async function initOutbox(userId: string) {
  currentUserId = userId;
  if (!loaded) {
    try {
      const raw = await window.timeStaff.storage.loadOutbox();
      if (raw) {
        const parsed = JSON.parse(raw) as { ops?: OutboxOp[] };
        if (Array.isArray(parsed.ops)) ops = parsed.ops;
      }
    } catch (err) {
      console.warn("Couldn't read the offline outbox", err);
    }
    loaded = true;
  }
  if (!autoSyncStarted) {
    autoSyncStarted = true;
    window.addEventListener("online", () => void drain());
    subscribeReachability(() => {
      if (isBackendReachable()) void drain();
    });
    setInterval(() => {
      if (pendingCount() > 0) void drain();
      else if (!isBackendReachable()) void probeBackend();
    }, AUTO_SYNC_INTERVAL_MS);
  }
  notify();
  void drain();
}

export function clearOutboxUser() {
  currentUserId = null;
  notify();
}

// --- Public: status ---------------------------------------------------------------

export interface OutboxStatus {
  version: number;
  pending: number;
  syncing: boolean;
  reachable: boolean;
  dropped: number;
}

let cachedStatus: OutboxStatus = { version: -1, pending: 0, syncing: false, reachable: true, dropped: 0 };

// A stable object per change, as useSyncExternalStore requires.
export function getOutboxStatus(): OutboxStatus {
  if (cachedStatus.version !== statusVersion) {
    cachedStatus = {
      version: statusVersion,
      pending: pendingCount(),
      syncing: draining !== null,
      reachable: isBackendReachable(),
      dropped: droppedCount,
    };
  }
  return cachedStatus;
}

export function subscribeOutbox(cb: () => void) {
  listeners.add(cb);
  const unsubscribeReachability = subscribeReachability(notify);
  return () => {
    listeners.delete(cb);
    unsubscribeReachability();
  };
}

export function pendingCount(): number {
  return ops.filter((o) => o.userId === currentUserId).length;
}

export function acknowledgeDropped() {
  droppedCount = 0;
  notify();
}

// The timer that was started but never stopped according to the outbox —
// how a relaunch (or a crash) while offline finds the entry it was tracking.
// null when the outbox says nothing is running.
export function unsyncedRunningEntry(userId: string): { entryId: string; taskId: string; startedAt: string } | null {
  const mine = ops.filter((o) => o.userId === userId);
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const op = mine[i];
    if (op.type !== "start") continue;
    const stopped = mine.slice(i + 1).some((o) => o.type === "stop" && o.entryId === op.entryId);
    if (!stopped) return { entryId: op.entryId, taskId: op.taskId, startedAt: op.startedAt };
  }
  return null;
}

// --- Sending ----------------------------------------------------------------------

type SendOutcome = "done" | "retry" | "drop";

function describe(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    return message ?? err.message;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

async function send(op: OutboxOp): Promise<SendOutcome> {
  try {
    switch (op.type) {
      case "start":
        await apiStartTimer(op.taskId, { id: op.entryId, startedAt: op.startedAt });
        return "done";
      case "stop":
        await apiStopTimer(op.entryId, op.endedAt);
        return "done";
      case "screenshot": {
        const bytes = await window.timeStaff.storage.readBlob(op.id);
        if (!bytes) {
          // The file is gone (cleared app data, disk cleanup) — nothing to send.
          droppedReasons.set(op.opId, "screenshot file missing");
          return "drop";
        }
        await uploadScreenshot(op.taskId, new Blob([bytes as BlobPart], { type: "image/png" }), {
          id: op.id,
          timeEntryId: op.entryId,
          takenAt: op.takenAt,
        });
        return "done";
      }
      case "activity":
        await reportActivity(op.taskId, {
          id: op.id,
          timeEntryId: op.entryId,
          activeSec: op.activeSec,
          totalSec: op.totalSec,
          sampledAt: op.sampledAt,
        });
        return "done";
    }
  } catch (err) {
    if (isTransientError(err)) return "retry";
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      // Signed out / session expired mid-sync — keep everything and try
      // again after the user signs back in.
      return "retry";
    }
    // A stop for an entry the backend already closed is exactly what the
    // queue wanted — not a failure.
    if (op.type === "stop" && /already been stopped/i.test(describe(err))) return "done";
    // Screenshots on a plan without the feature will never be accepted.
    if (op.type === "screenshot" && isEntitlementError(err)) {
      droppedReasons.set(op.opId, "plan has no screenshots");
      return "drop";
    }
    droppedReasons.set(op.opId, describe(err));
    return "drop";
  }
}

async function removeOp(op: OutboxOp) {
  ops = ops.filter((o) => o.opId !== op.opId);
  if (op.type === "screenshot") {
    await window.timeStaff.storage.deleteBlob(op.id).catch(() => undefined);
  }
  await persist();
}

// Replays queued ops strictly in order (a stop must not overtake its start).
// A transient failure pauses the whole queue and leaves the op in place; a
// permanent one drops just that op. Concurrent callers share one run — but a
// request that arrives *during* a run (typically "the connection just came
// back" landing while a pass that started offline is still failing its last
// op) schedules one more pass, instead of being swallowed by the stale one.
let drainRequestedAgain = false;

async function drainPass() {
  for (;;) {
    const op = ops.find((o) => o.userId === currentUserId);
    if (!op) return;
    const outcome = await send(op);
    if (outcome === "retry") return;
    if (outcome === "drop") {
      droppedCount += 1;
      console.warn("Dropped an unsyncable offline op", op.type, droppedReasons.get(op.opId));
    }
    await removeOp(op);
    notify();
  }
}

export function drain(): Promise<void> {
  if (draining) {
    drainRequestedAgain = true;
    return draining;
  }
  draining = (async () => {
    notify();
    try {
      do {
        drainRequestedAgain = false;
        await drainPass();
      } while (drainRequestedAgain);
    } finally {
      draining = null;
      notify();
    }
  })();
  return draining;
}

async function enqueue(op: OutboxOp) {
  ops.push(op);
  await persist();
  notify();
}

// After queueing, give the queue one chance to flush right now (we may well
// be online with a backlog) and report whether *this* op was refused for good
// — so a non-network failure still surfaces to the user instead of vanishing.
//
// `attemptNow` is false right after a direct call just failed transiently:
// retrying the same dead request immediately would only double the wait on a
// timeout — the background sync picks it up instead.
async function enqueueAndTry(op: OutboxOp, attemptNow: boolean): Promise<{ queued: boolean }> {
  await enqueue(op);
  if (!attemptNow) return { queued: true };
  await drain();
  const reason = droppedReasons.get(op.opId);
  if (reason !== undefined) {
    droppedReasons.delete(op.opId);
    // It was dropped (and counted) by drain — it isn't "dropped silently"
    // since the caller is about to show this message.
    droppedCount = Math.max(0, droppedCount - 1);
    notify();
    throw new Error(reason);
  }
  return { queued: ops.some((o) => o.opId === op.opId) };
}

// --- Public: operations -------------------------------------------------------------

// A direct send is only right when nothing is queued ahead of it (it would
// overtake the backlog) and the backend isn't known to be down (it would
// just sit on a timeout before being queued anyway).
function canSendDirect(): boolean {
  return pendingCount() === 0 && isBackendReachable();
}

function newBase(userId: string) {
  return { opId: uuid(), userId };
}

export interface StartResult {
  entry: RunningTimeEntry;
  // True when the backend hasn't confirmed it yet (tracked locally and
  // synced later).
  queued: boolean;
}

export async function startEntry(userId: string, taskId: string): Promise<StartResult> {
  const entryId = uuid();
  const startedAt = new Date().toISOString();
  const local: RunningTimeEntry = { id: entryId, taskId, userId, startedAt, endedAt: null, durationSec: null };

  // With a backlog, a direct call would jump the queue (a start landing
  // before the stops queued ahead of it) — go through the queue instead.
  let justFailed = false;
  if (canSendDirect()) {
    try {
      const entry = await apiStartTimer(taskId, { id: entryId, startedAt });
      return { entry, queued: false };
    } catch (err) {
      if (!isTransientError(err)) throw err;
      justFailed = true;
    }
  }

  const { queued } = await enqueueAndTry(
    { type: "start", ...newBase(userId), entryId, taskId, startedAt },
    !justFailed && isBackendReachable(),
  );
  return { entry: local, queued };
}

export function hasPendingStop(userId: string, entryId: string): boolean {
  return ops.some((o) => o.userId === userId && o.type === "stop" && o.entryId === entryId);
}

export async function stopEntry(
  userId: string,
  entryId: string,
  endedAt: Date = new Date(),
  // For callers that can't wait on a slow network (the window is closing):
  // give the direct attempt this long, then persist the stop instead.
  opts: { timeoutMs?: number } = {},
): Promise<{ queued: boolean }> {
  const endedAtIso = endedAt.toISOString();

  let justFailed = false;
  if (canSendDirect()) {
    try {
      await apiStopTimer(entryId, endedAtIso, opts.timeoutMs);
      return { queued: false };
    } catch (err) {
      if (axios.isAxiosError(err) && /already been stopped/i.test(describe(err))) return { queued: false };
      if (!isTransientError(err)) throw err;
      justFailed = true;
    }
  }

  return enqueueAndTry(
    { type: "stop", ...newBase(userId), entryId, endedAt: endedAtIso },
    !justFailed && isBackendReachable(),
  );
}

// Best-effort by design: a missed screenshot is never worth interrupting
// tracking over. Throws only for an entitlement refusal, so the caller can
// stop trying; transient failures are queued, anything else is swallowed.
export async function submitScreenshot(args: {
  userId: string;
  taskId: string;
  entryId: string;
  bytes: Uint8Array;
}): Promise<{ queued: boolean }> {
  const id = uuid();
  const takenAt = new Date().toISOString();

  if (canSendDirect()) {
    try {
      await uploadScreenshot(args.taskId, new Blob([args.bytes as BlobPart], { type: "image/png" }), {
        id,
        timeEntryId: args.entryId,
        takenAt,
      });
      return { queued: false };
    } catch (err) {
      if (isEntitlementError(err)) throw err;
      if (!isTransientError(err)) return { queued: false };
    }
  }

  if (ops.filter((o) => o.type === "screenshot").length >= MAX_QUEUED_SCREENSHOTS) {
    return { queued: false };
  }
  await window.timeStaff.storage.writeBlob(id, args.bytes);
  await enqueue({
    type: "screenshot",
    ...newBase(args.userId),
    id,
    entryId: args.entryId,
    taskId: args.taskId,
    takenAt,
  });
  void drain();
  return { queued: true };
}

export async function submitActivity(args: {
  userId: string;
  taskId: string;
  entryId: string;
  activeSec: number;
  totalSec: number;
  sampledAt: Date;
  // Skip the direct attempt and just persist — for when the app is about to
  // close and there's no time to wait on the network.
  queueOnly?: boolean;
}): Promise<void> {
  const payload = {
    id: uuid(),
    timeEntryId: args.entryId,
    activeSec: args.activeSec,
    totalSec: args.totalSec,
    sampledAt: args.sampledAt.toISOString(),
  };

  if (!args.queueOnly && canSendDirect()) {
    try {
      await reportActivity(args.taskId, payload);
      return;
    } catch (err) {
      if (!isTransientError(err)) return; // refused for good — drop the sample
    }
  }

  if (ops.filter((o) => o.type === "activity").length >= MAX_QUEUED_ACTIVITY) return;
  await enqueue({
    type: "activity",
    ...newBase(args.userId),
    id: payload.id,
    entryId: args.entryId,
    taskId: args.taskId,
    activeSec: args.activeSec,
    totalSec: args.totalSec,
    sampledAt: payload.sampledAt,
  });
  void drain();
}
