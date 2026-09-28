import { useState } from "react";
import { ScreenshotToastCard } from "./ScreenshotToastCard";
import {
  DEFAULT_SCREENSHOT_ALERT_POSITION,
  SCREENSHOT_ALERT_POSITIONS,
  getScreenshotAlertPosition,
  setScreenshotAlertPosition,
  type ScreenshotAlertPosition,
} from "./lib/settings";

// The app's Settings page — currently just where the "screenshot captured"
// popup appears. Rendered by App in place of the main tracker view, so the
// timer, idle detection and floating widget keep running underneath while
// this is open; "Back" just swaps the view back.
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [position, setPosition] = useState<ScreenshotAlertPosition>(() => getScreenshotAlertPosition());
  const [justSaved, setJustSaved] = useState(false);

  function choose(next: ScreenshotAlertPosition) {
    setPosition(next);
    setScreenshotAlertPosition(next);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1500);
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="settings-back-btn" onClick={onBack}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back to home
        </button>
        <h1 className="settings-title">Settings</h1>
      </div>

      <div className="settings-body">
        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h2>Screenshot alert position</h2>
              <p>Choose where the “Screenshot captured” popup appears on your screen.</p>
            </div>
            <div className="settings-card-actions">
              {justSaved && <span className="settings-saved">Saved</span>}
              <button
                className="settings-test-btn"
                onClick={() => window.timeStaff.notifyScreenshotCaptured(position)}
              >
                Show test alert
              </button>
            </div>
          </div>

          <div className="position-grid" role="radiogroup" aria-label="Screenshot alert position">
            {SCREENSHOT_ALERT_POSITIONS.map((option) => {
              const selected = option.value === position;
              return (
                <button
                  key={option.value}
                  role="radio"
                  aria-checked={selected}
                  className={`position-option ${selected ? "selected" : ""}`}
                  onClick={() => choose(option.value)}
                >
                  <span className="mock-screen">
                    <span className={`mock-toast pos-${option.value}`}>
                      <ScreenshotToastCard />
                    </span>
                  </span>
                  <span className="position-option-label">
                    <span className="position-radio" />
                    {option.label}
                    {option.value === DEFAULT_SCREENSHOT_ALERT_POSITION && <span className="position-default">Default</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
