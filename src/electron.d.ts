export {};

interface IdleAlertShowData {
  idleSeconds: number;
  projectName: string;
  taskName: string;
}

interface IdleAlertResponse {
  action: "stop" | "resume";
  wasWorking: "no" | "yes";
}

interface MiniTimerData {
  taskName: string;
  projectName: string;
  elapsedSeconds: number;
  status: "running" | "paused" | "idle-warning" | "idle-critical";
}

type MiniTimerAction = "pause" | "resume" | "dismiss";

declare global {
  interface Window {
    // Exposed by preload.ts via contextBridge — see that file for what's
    // actually allowed through to the renderer.
    timeStaff: {
      platform: NodeJS.Platform;
      getIdleSeconds: () => Promise<number>;
      openExternal: (url: string) => Promise<void>;
      captureScreenshot: () => Promise<Uint8Array>;
      notifyScreenshotCaptured: () => Promise<void>;
      auth: {
        getRefreshToken: () => Promise<string | null>;
        setRefreshToken: (token: string) => Promise<boolean>;
        clearRefreshToken: () => Promise<void>;
      };
      windowControls: {
        minimize: () => void;
        maximizeToggle: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
      };
      miniTimer: {
        show: (data: MiniTimerData) => void;
        update: (data: MiniTimerData) => void;
        hide: () => void;
        respondAction: (action: MiniTimerAction) => void;
        onData: (callback: (data: MiniTimerData) => void) => () => void;
        onAction: (callback: (action: MiniTimerAction) => void) => () => void;
      };
      onBeforeClose: (callback: () => void) => () => void;
      confirmReadyToClose: () => void;
      idleAlert: {
        show: (data: IdleAlertShowData) => void;
        hide: () => void;
        respond: (response: IdleAlertResponse) => void;
        onResponse: (callback: (response: IdleAlertResponse) => void) => () => void;
        onData: (callback: (data: IdleAlertShowData) => void) => () => void;
      };
    };
  }
}
