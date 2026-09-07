interface IdleAlertDialogProps {
  idleSeconds: number;
  projectName: string;
  taskName: string;
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
            <span>Task: {taskName}</span>
          </div>
        </div>

        <p className="idle-footnote">
          Idle time is discarded from your logged time unless you resume.
        </p>

        <div className="idle-actions">
          <button className="idle-btn outline" onClick={onStop} disabled={busy}>
            Stop timer
          </button>
          <button className="idle-btn filled" onClick={onResume} disabled={busy}>
            Resume timer
          </button>
        </div>
      </div>
    </div>
  );
}
