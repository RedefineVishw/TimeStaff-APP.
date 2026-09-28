import { useEffect } from "react";
import { ScreenshotToastCard } from "./ScreenshotToastCard";

// The content of the small always-on-top popup window that replaces the
// native OS toast (see createScreenshotToastWindow in main.ts) — a native
// toast is always placed by the OS (bottom right on Windows), which can't be
// changed, so to let the user pick a position this is drawn as our own
// window instead. main.ts positions it, shows it without stealing focus, and
// closes it after a few seconds; the X closes it right away.
export function ScreenshotToastWindowApp() {
  // Same transparent-window trick as the mini timer: the shared stylesheet
  // paints an opaque <body> for every other window.
  useEffect(() => {
    document.body.classList.add("toast-window");
    return () => document.body.classList.remove("toast-window");
  }, []);

  return (
    <div className="toast-stage">
      <ScreenshotToastCard onDismiss={() => window.timeStaff.screenshotToast.dismiss()} />
    </div>
  );
}
