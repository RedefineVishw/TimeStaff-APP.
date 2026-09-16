interface IdleAlertDialogProps {
  idleSeconds: number;
  projectName: string;
  taskName: string;
  wasWorking: "no" | "yes";
  onWasWorkingChange: (value: "no" | "yes") => void;
  onStop: () => void;
  onResume: () => void;
  busy: boolean;
}

function formatIdleLabel(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function IdleAlertDialog({
  idleSeconds,
  projectName,
  taskName,
  wasWorking,
  onWasWorkingChange,
  onStop,
  onResume,
  busy,
}: IdleAlertDialogProps) {
  return (
    <div className="idle-overlay">
      <div className="idle-dialog">
        <h2>Idle time alert</h2>

        <div className="idle-card">
          <p className="idle-label">You have been idle for</p>
          <p className="idle-amount">{formatIdleLabel(idleSeconds)}</p>
          <div className="idle-context">
            <span>Project: {projectName}</span>
            <span>To-do: {taskName}</span>
          </div>
        </div>

        <div className="idle-question">
          <p className="idle-question-label">Were you working?</p>
          <label className="idle-radio">
            <input
              type="radio"
              name="was-working"
              checked={wasWorking === "no"}
              onChange={() => onWasWorkingChange("no")}
            />
            No, discard idle time
          </label>
          <label className="idle-radio">
            <input
              type="radio"
              name="was-working"
              checked={wasWorking === "yes"}
              onChange={() => onWasWorkingChange("yes")}
            />
            Yes, keep idle time
          </label>
        </div>

        <div className="idle-actions">
          <button
            className="idle-btn outline"
            onClick={onStop}
            disabled={busy}
            title="Stop the timer"
          >
            Stop timer
          </button>
          <button
            className="idle-btn filled"
            onClick={onResume}
            disabled={busy}
            title="Keep tracking"
          >
            Resume timer
          </button>
        </div>
      </div>
    </div>
  );
}
