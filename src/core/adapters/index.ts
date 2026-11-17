import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { dshAdapter } from "./dsh";
import { workbuddyAdapter } from "./workbuddy";
import { loadManifests, manifestAdapter } from "./custom";
import { customSessionAdapter } from "./custom-session";
import { readConfig } from "../config";
import { Adapter } from "./types";

export const BUILTIN_ADAPTERS: Adapter[] = [claudeAdapter, codexAdapter, cursorAdapter, dshAdapter, workbuddyAdapter];

export function allAdapters(): Adapter[] {
  const configured = (readConfig().customUsageAgents ?? [])
    .filter(agent => agent.scanSessions)
    .map(customSessionAdapter);
  return [...BUILTIN_ADAPTERS, ...loadManifests().map(manifestAdapter), ...configured];
}

export function getAdapter(id: string): Adapter | undefined {
  return allAdapters().find((a) => a.id === id);
}

export * from "./types";
