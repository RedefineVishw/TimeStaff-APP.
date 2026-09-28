// The "screenshot captured" popup's visual, modeled on a Windows 11 toast —
// app logo on the left, the bold app-name title, the message underneath, and
// a dismiss button — since it replaces the native OS toast this app used to
// show. One component shared by the real popup window
// (ScreenshotToastWindowApp) and every preview in Settings, so a preview is
// exactly what appears. Without `onDismiss` it renders as a static preview
// (the X is drawn but not clickable).
export function ScreenshotToastCard({ onDismiss }: { onDismiss?: () => void }) {
  const xIcon = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );

  return (
    <div className="toast-card">
      <svg className="toast-card-logo" viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#4F46E5" />
        <rect x="13.5" y="3" width="5" height="3" rx="1.2" fill="#fff" />
        <rect x="20.3" y="5" width="4" height="2.6" rx="1" fill="#fff" transform="rotate(45 22.3 6.3)" />
        <circle cx="16" cy="18.5" r="10" fill="none" stroke="#fff" strokeWidth="2.3" />
        <line x1="16" y1="18.5" x2="16" y2="12.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        <line x1="16" y1="18.5" x2="20" y2="18.5" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
      <span className="toast-card-text">
        <span className="toast-card-title">TimeStaff</span>
        <span className="toast-card-body">Screenshot captured.</span>
      </span>
      {onDismiss ? (
        <button className="toast-card-dismiss" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
          {xIcon}
        </button>
      ) : (
        <span className="toast-card-dismiss static" aria-hidden>
          {xIcon}
        </span>
      )}
    </div>
  );
}
