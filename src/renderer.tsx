import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IdleAlertWindowApp } from "./IdleAlertWindowApp";
import { MiniTimerWindowApp } from "./MiniTimerWindowApp";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element in index.html");

// The idle-alert and mini-timer popups are genuinely separate
// BrowserWindows (see main.ts), but they load this same renderer bundle —
// Electron Forge's Vite plugin only defines one renderer target. Route by
// URL hash instead of standing up a second bundle per window.
function renderForHash() {
  switch (window.location.hash) {
    case "#idle-alert":
      return <IdleAlertWindowApp />;
    case "#mini-timer":
      return <MiniTimerWindowApp />;
    default:
      return <App />;
  }
}

createRoot(root).render(<StrictMode>{renderForHash()}</StrictMode>);
