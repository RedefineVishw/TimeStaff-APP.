import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IdleAlertWindowApp } from "./IdleAlertWindowApp";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element in index.html");

// The idle-alert popup is a genuinely separate BrowserWindow (see
// main.ts), but it loads this same renderer bundle — Electron Forge's Vite
// plugin only defines one renderer target. Route by URL hash instead of
// standing up a second bundle.
const isIdleAlertWindow = window.location.hash === "#idle-alert";

createRoot(root).render(
  <StrictMode>{isIdleAlertWindow ? <IdleAlertWindowApp /> : <App />}</StrictMode>,
);
