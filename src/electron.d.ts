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

declare global {
  interface Window {
    // Exposed by preload.ts via contextBridge — see that file for what's
    // actually allowed through to the renderer.
    timeStaff: {
      getIdleSeconds: () => Promise<number>;
      openExternal: (url: string) => Promise<void>;
      captureScreenshot: () => Promise<Uint8Array>;
      notifyScreenshotCaptured: () => Promise<void>;
      auth: {
        getRefreshToken: () => Promise<string | null>;
        setRefreshToken: (token: string) => Promise<boolean>;
        clearRefreshToken: () => Promise<void>;
      };
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
