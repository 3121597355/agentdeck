export type AgentId = string; // "claude" | "codex" | custom adapter id
export type Host = "cli" | "app";

/** A finished turn is ready for another prompt; only an explicit completion is done. */
export type Status = "running" | "needs_input" | "ready" | "done" | "idle" | "unknown";

/** Why a session needs attention (borrowed from t3code: input / permission / failed / quota). */
export type Attention = "input" | "question" | "permission" | "failed" | "quota" | "interrupted";

/**
 * Unified event format written by every adapter.
 * - started: a session was opened or resumed
 * - progress: the user sent a prompt, the agent is working
 * - tool: tool activity; only matching request IDs resolve pending input
 * - needs_input: the agent is blocked on the user
 * - stopped: the turn ended; ready for another prompt, not task completion
 * - failed / quota: the turn ended abnormally
 * - completed: explicit task completion from an integration
 * - resolved: a matching request was answered or canceled
 * - snapshot: bounded source reconciliation (internal only)
 * - ended: the process exited; unknown if it was running
 */
export type EventType =
  | "started"
  | "progress"
  | "tool"
  | "needs_input"
  | "resolved"
  | "stopped"
  | "completed"
  | "failed"
  | "quota"
  | "interrupted"
  | "ended"
  | "snapshot";

export interface PendingRequest {
  id: string;
  attention: Attention;
  at: number;
  turnId?: string;
  /** Text inference / legacy notifications clear on a new user prompt. Structured requests do not. */
  inferred?: boolean;
}

export interface SessionState {
  phase: Exclude<Status, "needs_input">;
  at: number;
  source: string;
  turnId?: string;
  turnStartedAt?: number;
  pending: PendingRequest[];
  /** Prevent a late duplicate request from reopening an answered question. */
  resolved: string[];
}

export interface Locator {
  /** Agent process identity captured by hooks; start time protects against PID reuse. */
  pid?: number;
  processStartedAt?: string;
  observedAt?: number;
  /** Controlling terminal of the agent process, e.g. /dev/ttys003 */
  tty?: string;
  /** $TMUX_PANE, e.g. %12 */
  tmuxPane?: string;
  /** tmux server socket path (first field of $TMUX) */
  tmuxSocket?: string;
  /** Bundle id of the terminal / app that hosts the session (from $__CFBundleIdentifier) */
  bundleId?: string;
  /** $TERM_PROGRAM */
  termProgram?: string;
  /** Codex desktop host id, when known */
  hostId?: string;
  /** Claude desktop's local_* ID, distinct from the CLI transcript UUID. */
  claudeDesktopId?: string;
  /** Explicit Claude runtime source; kept so a CLI resume can override an old desktop mapping. */
  claudeEntrypoint?: string;
}

export interface AgentEvent {
  agent: AgentId;
  sessionId: string;
  type: EventType;
  host?: Host;
  cwd?: string;
  /** Candidate title (e.g. first prompt). Only used when the session has no title yet. */
  title?: string;
  /** Last sentence from the agent, or the notification message. */
  summary?: string;
  attention?: Attention;
  locator?: Locator;
  transcriptPath?: string;
  source?: string;
  eventId?: string;
  turnId?: string;
  requestIds?: string[];
  inferred?: boolean;
  snapshot?: SessionState;
  snapshotComplete?: boolean;
  at: number;
}

export interface Session {
  agent: AgentId;
  sessionId: string;
  host: Host;
  title: string;
  /** Observation time for independently synchronized metadata; not conversation activity. */
  titleObservedAt?: number;
  titleSource?: string;
  cwd: string;
  status: Status;
  attention: Attention | null;
  summary: string;
  locator: Locator;
  subscribed: boolean;
  /** Set by "Mark as Handled" (⌘D). Cleared when the status changes. */
  handledAt: number | null;
  startedAt: number;
  updatedAt: number;
  transcriptPath: string;
  state?: SessionState;
  revision?: number;
}

export interface SessionTitle {
  agent: AgentId;
  sessionId: string;
  title: string;
  observedAt: number;
  source: string;
}

/** A transcript found on disk by the history scan (not in the hook database). */
export interface HistoryEntry {
  agent: AgentId;
  sessionId: string;
  host: Host;
  title: string;
  cwd: string;
  summary: string;
  startedAt: number;
  updatedAt: number;
  transcriptPath: string;
  locator?: Locator;
}

export interface Config {
  notifications: boolean;
  /** Desktop appearance; missing values follow the operating system. */
  theme?: "light" | "dark" | "system";
  /** Channel IDs; credentials and transport details belong to the channel implementation. */
  notificationChannels?: string[];
  /** Explicit opt-in to reading and indexing full local conversation bodies. */
  contentSearchEnabled: boolean;
  /** raycast://extensions/<owner>/<extension> — written by the extension so the CLI can build deeplinks. */
  deeplinkBase: string;
  /** Terminal used when a CLI session has to be resumed in a new window. */
  resumeTerminal: ResumeTerminal;
  /** User-defined JSONL sources included in local Agent usage statistics. */
  customUsageAgents?: CustomUsageAgent[];
}

export type ResumeTerminal = "terminal" | "iterm" | "ghostty";

export type UsageTimestampUnit = "auto" | "iso" | "ms" | "seconds";

export interface CustomUsageAgent {
  /** Stable internal ID. Names remain editable without orphaning source settings. */
  id: string;
  name: string;
  /** A local file or directory. Scans are always read-only and recursive. */
  path: string;
  /** Comma-separated filename patterns using * and ?, such as *.jsonl,events.log */
  filePattern: string;
  /** Dot-separated JSON property path, such as timestamp or event.created_at */
  timestampField: string;
  timestampUnit: UsageTimestampUnit;
  enabled: boolean;
  /** Also discover sessions from the same local records and monitor subscribed files. */
  scanSessions?: boolean;
  /** Dot-separated paths for common session metadata in generic JSONL records. */
  sessionIdField?: string;
  eventTypeField?: string;
  titleField?: string;
  cwdField?: string;
  summaryField?: string;
  requestIdField?: string;
  /** Optional desktop deep link. Supports {sessionId} and {cwd}. */
  jumpUrl?: string;
}
