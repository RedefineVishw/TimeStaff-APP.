// Where the "screenshot captured" popup appears on screen. Kept per-machine
// (localStorage) rather than on the server — it's a preference about this
// particular display, not something an org admin controls.
export type ScreenshotAlertPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left-center"
  | "center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

// Ordered the way they sit on a screen (top row, middle row, bottom row), so
// the Settings grid of previews is itself a map of where each one goes.
export const SCREENSHOT_ALERT_POSITIONS: { value: ScreenshotAlertPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "left-center", label: "Left center" },
  { value: "center", label: "Center" },
  { value: "right-center", label: "Right center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
];

// Bottom right is what the alert used to be hardwired to (the OS toast
// position), so it stays the default for anyone who never opens Settings.
export const DEFAULT_SCREENSHOT_ALERT_POSITION: ScreenshotAlertPosition = "bottom-right";

const STORAGE_KEY = "timestaff.screenshotAlertPosition";

function isPosition(value: unknown): value is ScreenshotAlertPosition {
  return SCREENSHOT_ALERT_POSITIONS.some((p) => p.value === value);
}

export function getScreenshotAlertPosition(): ScreenshotAlertPosition {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isPosition(stored)) return stored;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return DEFAULT_SCREENSHOT_ALERT_POSITION;
}

export function setScreenshotAlertPosition(position: ScreenshotAlertPosition) {
  try {
    window.localStorage.setItem(STORAGE_KEY, position);
  } catch {
    // Not persisted this time — the choice still applies until restart.
  }
}
