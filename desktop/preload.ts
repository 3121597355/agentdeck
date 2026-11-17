import { contextBridge, ipcRenderer } from "electron";

// A narrow IPC bridge: web content cannot execute shell commands or read arbitrary files.
contextBridge.exposeInMainWorld("inbox", {
  snapshot: () => ipcRenderer.invoke("inbox:snapshot"),
  search: (query: string) => ipcRenderer.invoke("inbox:search", query),
  usage: (days: number) => ipcRenderer.invoke("inbox:usage", days),
  usageSource: (request: Record<string, unknown>) => ipcRenderer.invoke("inbox:usage-source", request),
  action: (action: string, agent: string, sessionId: string) => ipcRenderer.invoke("inbox:action", action, agent, sessionId),
  settings: (patch: Record<string, unknown>) => ipcRenderer.invoke("inbox:settings", patch),
  connection: (agent: string, operation: string) => ipcRenderer.invoke("inbox:connection", agent, operation),
  system: (action: string) => ipcRenderer.invoke("inbox:system", action),
  onUpdate: (callback: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => callback(value);
    ipcRenderer.on("inbox:update", handler);
    return () => ipcRenderer.removeListener("inbox:update", handler);
  },
});
