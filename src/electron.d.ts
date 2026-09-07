export {};

declare global {
  interface Window {
    // Exposed by preload.ts via contextBridge — see that file for what's
    // actually allowed through to the renderer.
    timeStaff: {
      getIdleSeconds: () => Promise<number>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
