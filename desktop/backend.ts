import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, isAbsolute, join } from "node:path";
import { allAdapters, getAdapter } from "../src/core/adapters";
import { Store } from "../src/core/db";
import { readConfig, writeConfig } from "../src/core/config";
import { scanHistory } from "../src/core/history";
import { mergeSessions } from "../src/core/merge";
import { readCodexDesktopSessions } from "../src/core/codex-desktop";
import { EventEngine } from "../src/core/engine";
import { TranscriptCollector } from "../src/core/sources/collector";
import { HostSourceCollector } from "../src/core/sources/hosts";
import { TitleSynchronizer } from "../src/core/titles";
import { deliverNotifications, NotificationChannel } from "../src/core/notifications";
import { SessionSearchIndex } from "../src/core/search";
import { IndexQueue } from "../src/core/index-queue";
import { ROOT, LOG_PATH } from "../src/core/paths";
import { applyPlan } from "../src/core/install";
import { collectUsage } from "../src/core/usage";
import { clearCustomSessionCache } from "../src/core/adapters/custom-session";
import type { Session, HistoryEntry, Config, CustomUsageAgent, UsageTimestampUnit } from "../src/core/types";
import type { HookContext } from "../src/core/adapters/types";
import type { UsageReport } from "../src/core/usage";

export class InboxBackend {
  readonly store = new Store();
  private collector = new TranscriptCollector(new EventEngine(this.store, readConfig), allAdapters, (text) => this.log(text));
  private hosts = new HostSourceCollector(new EventEngine(this.store, readConfig), allAdapters, (text) => this.log(text));
  private titles = new TitleSynchronizer(this.store, allAdapters);
  private discovered = new Map<string, HistoryEntry[]>();
  private discoveryErrors: Record<string, string> = {};
  private history: HistoryEntry[] = [];
  private sessions: Session[] = [];
  private lastScan = 0;
  private refreshing?: Promise<void>;
  private forceRefreshPending = false;
  private index = new SessionSearchIndex();
  private indexQueue?: IndexQueue;
  private indexState = { busy: false, completed: 0, total: 0, failed: 0 };
  private usageCache = new Map<number, {at: number; promise: Promise<UsageReport>}>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  lastError = "";
  updatedAt = 0;

  constructor(private notify: NotificationChannel, private publish: () => void, readonly context: HookContext) {}

  log(text: string) {
    mkdirSync(ROOT, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`);
  }

  async start() {
    writeConfig({ notificationChannels: ["windows"] });
    await this.refresh(true);
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.indexQueue?.dispose();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(async () => { await this.refresh(); this.schedule(); }, 2000);
  }

  refresh(force = false): Promise<void> {
    if (force) this.forceRefreshPending = true;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      do {
        const forceNow = this.forceRefreshPending;
        this.forceRefreshPending = false;
        await this.performRefresh(forceNow);
      } while (this.forceRefreshPending);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async performRefresh(force: boolean) {
    try {
      await this.collector.poll();
      await this.hosts.poll();
      if (force || Date.now() - this.lastScan > 15000) {
        this.history = scanHistory({limit:1000});
        const seen = new Set(this.history.map(s => `${s.agent}:${s.sessionId}`));
        const catalog = await readCodexDesktopSessions();
        const names = new Map(catalog.map(s => [s.sessionId, s.title]));
        this.history = this.history.map(s => s.agent === "codex" && names.has(s.sessionId) ? {...s, title:names.get(s.sessionId)!} : s);
        this.history.push(...catalog.filter(s => !seen.has(`${s.agent}:${s.sessionId}`)));
        const sources = allAdapters().filter(adapter => adapter.id !== "claude" && adapter.id !== "codex" && adapter.source?.discover);
        const activeSources = new Set(sources.map(adapter => adapter.id));
        for (const id of this.discovered.keys()) if (!activeSources.has(id)) this.discovered.delete(id);
        const results = await Promise.allSettled(sources.map(adapter => adapter.source!.discover!()));
        for (const [index, result] of results.entries()) {
          const adapter = sources[index];
          if (result.status === "fulfilled") {
            this.discovered.set(adapter.id, result.value.filter(entry => entry.agent === adapter.id));
            delete this.discoveryErrors[adapter.id];
          } else {
            const error = `${adapter.name}: ${String(result.reason)}`;
            if (error !== this.discoveryErrors[adapter.id]) this.log(error);
            this.discoveryErrors[adapter.id] = error;
          }
        }
        for (const entries of this.discovered.values()) this.history.push(...entries);
        this.lastScan = Date.now();
      }
      // Hooks retain prompt titles even for unsubscribed rows. Refresh labels after
      // merging every visible session, independently of notification subscriptions.
      this.sessions = await this.titles.refresh(mergeSessions(await this.store.all(2000), this.history));
      await deliverNotifications(this.store, readConfig(), [this.notify]);
      this.lastError = "";
      this.updatedAt = Date.now();
      if (readConfig().contentSearchEnabled) this.updateIndex();
    } catch (error) {
      this.lastError = String(error);
      this.log(this.lastError);
    }
    this.publish();
  }

  private updateIndex() {
    this.indexQueue ??= new IndexQueue(this.index, {
      busy: value => {this.indexState.busy = value; this.publish();},
      progress: value => {Object.assign(this.indexState, value); this.publish();},
      completed: () => this.publish(),
      failed: () => {this.indexState.failed++; this.publish();},
    });
    void this.indexQueue.update(this.sessions);
  }

  snapshot() {
    return { sessions: this.sessions, settings: readConfig(), updatedAt: this.updatedAt, error: this.lastError,
      index: this.indexState, dataDir: ROOT,
      connections: allAdapters().map(adapter => {
        const custom = readConfig().customUsageAgents?.find(agent => agent.id === adapter.id);
        let detected = { present: false, hooked: false };
        let notes: string[] = [];
        let configurationError = "";
        try {
          detected = adapter.detect();
          if (adapter.custom || ["dsh", "workbuddy", "cursor"].includes(adapter.id)) notes = adapter.planInstall(this.context).notes;
        } catch (error) { configurationError = `配置读取失败：${String(error)}`; }
        const hookable = !!adapter.parseHook;
        return {agent: adapter.id, name: adapter.name, present: detected.present, hooked: detected.hooked, hookable,
          monitoring: !!adapter.source?.poll || !!adapter.source?.transcript,
          count: this.sessions.filter(session => session.agent === adapter.id).length,
          error: configurationError || this.discoveryErrors[adapter.id] || this.hosts.errors[adapter.id] || "",
          notes, custom: !!adapter.custom, editable: !!adapter.custom, enabled: custom?.enabled ?? true,
          path: custom?.path ?? "", filePattern: custom?.filePattern ?? "",
          timestampField: custom?.timestampField ?? "", timestampUnit: custom?.timestampUnit ?? "auto",
          sessionIdField: custom?.sessionIdField ?? "", eventTypeField: custom?.eventTypeField ?? "",
          titleField: custom?.titleField ?? "", cwdField: custom?.cwdField ?? "",
          summaryField: custom?.summaryField ?? "", requestIdField: custom?.requestIdField ?? "",
          jumpUrl: custom?.jumpUrl ?? "",
        };
      }),
    };
  }

  async search(query: string) {
    if (!readConfig().contentSearchEnabled || !query.trim()) return {};
    return this.index.search(query.slice(0,200));
  }

  async usage(days: number) {
    const cached = this.usageCache.get(days);
    if (cached && Date.now() - cached.at < 60_000) return cached.promise;
    const promise = collectUsage({
      days,
      customAgents: readConfig().customUsageAgents ?? [],
    }).catch(error => {
      this.usageCache.delete(days);
      throw error;
    });
    this.usageCache.set(days, {at: Date.now(), promise});
    return promise;
  }

  private invalidateUsageCache() {
    this.usageCache.clear();
  }

  async saveUsageAgent(raw: Record<string, unknown>) {
    const name = String(raw.name ?? "").trim();
    if (!name) throw new Error("请填写 Agent 名称。");
    if (name.length > 60) throw new Error("Agent 名称不能超过 60 个字符。");

    const path = String(raw.path ?? "").trim();
    if (!path) throw new Error("请选择或填写本地文件 / 目录。");
    if (path.length > 2_000) throw new Error("文件路径过长。");
    if (!isAbsolute(path)) throw new Error("请选择本地文件或目录，填写绝对路径。");

    const timestampField = String(raw.timestampField ?? "").trim();
    if (!timestampField || timestampField.length > 160) throw new Error("请填写有效的时间戳字段。");
    const segments = timestampField.split(".");
    if (
      segments.some(segment =>
        !/^[A-Za-z0-9_@-]+$/.test(segment) ||
        ["__proto__", "prototype", "constructor"].includes(segment)
      )
    ) {
      throw new Error("时间戳字段只能使用字母、数字、下划线、@、短横线和点号。");
    }

    const timestampUnit = String(raw.timestampUnit ?? "auto") as UsageTimestampUnit;
    if (!["auto", "iso", "ms", "seconds"].includes(timestampUnit)) throw new Error("不支持的 timestamp 格式。");

    const inferredPattern = extname(path) ? `*${extname(path)}` : "*.jsonl";
    const filePattern = String(raw.filePattern ?? "").trim().slice(0, 300) || inferredPattern;
    if (/[\\/:*?"<>|\0]/.test(filePattern.replace(/[*?]/g, ""))) {
      throw new Error("文件模式只填写文件名通配，例如 *.jsonl，不要包含目录。");
    }

    const requestedId = String(raw.id ?? "").trim();
    if (requestedId && !/^custom-[A-Za-z0-9-]{8,80}$/.test(requestedId)) throw new Error("自定义 Agent 标识无效。");
    const id = requestedId || `custom-${randomUUID()}`;
    const current = readConfig().customUsageAgents ?? [];
    const existing = current.find(agent => agent.id === id);
    if (current.some(agent => agent.id !== id && agent.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error("已经有同名的自定义 Agent，请换一个名称。");
    }
    const mappedField = (label: string, key: keyof CustomUsageAgent, fallback: string) => {
      const value = String(raw[key] ?? existing?.[key] ?? fallback).trim();
      if (!value || value.length > 160) throw new Error(`${label}不能为空。`);
      if (
        !/^[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*$/.test(value) ||
        /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(value)
      ) {
        throw new Error(`${label}只能使用字母、数字、下划线、@、短横线和点号。`);
      }
      return value;
    };
    const scanSessions = raw.scanSessions === true || existing?.scanSessions === true;
    const jumpUrl = String(raw.jumpUrl ?? existing?.jumpUrl ?? "").trim();
    if (jumpUrl && (!/^[a-z][a-z0-9+.-]*:\/\//i.test(jumpUrl) || jumpUrl.length > 2_000)) {
      throw new Error("回跳链接必须包含协议，例如 myagent://threads/{sessionId}。");
    }
    const nextAgent: CustomUsageAgent = {
      ...existing,
      id,
      name,
      path,
      filePattern,
      timestampField,
      timestampUnit,
      enabled: raw.enabled !== false,
      scanSessions,
      ...(scanSessions ? {
        sessionIdField: mappedField("会话 ID 字段", "sessionIdField", "session_id"),
        eventTypeField: mappedField("状态/事件字段", "eventTypeField", "type"),
        titleField: mappedField("标题字段", "titleField", "title"),
        cwdField: mappedField("工作目录字段", "cwdField", "cwd"),
        summaryField: mappedField("摘要字段", "summaryField", "summary"),
        requestIdField: mappedField("请求 ID 字段", "requestIdField", "request_id"),
        jumpUrl,
      } : {}),
    };
    const index = current.findIndex(agent => agent.id === id);
    const next = index >= 0
      ? current.map(agent => agent.id === id ? nextAgent : agent)
      : [...current, nextAgent];
    writeConfig({ customUsageAgents: next });
    this.invalidateUsageCache();
    clearCustomSessionCache();
    await this.refresh(true);
    return this.snapshot();
  }

  async saveCustomSessionAgent(raw: Record<string, unknown>) {
    return await this.saveUsageAgent({ ...raw, scanSessions: true });
  }

  async toggleUsageAgent(id: string, enabled: boolean) {
    const current = readConfig().customUsageAgents ?? [];
    if (!current.some(agent => agent.id === id)) throw new Error("这个自定义 Agent 已不存在。");
    writeConfig({
      customUsageAgents: current.map(agent => agent.id === id ? { ...agent, enabled: Boolean(enabled) } : agent),
    });
    this.invalidateUsageCache();
    clearCustomSessionCache();
    if (!enabled) this.discovered.delete(id);
    await this.refresh(true);
    return this.snapshot();
  }

  async deleteUsageAgent(id: string) {
    const current = readConfig().customUsageAgents ?? [];
    const next = current.filter(agent => agent.id !== id);
    if (next.length === current.length) throw new Error("这个自定义 Agent 已不存在。");
    writeConfig({ customUsageAgents: next });
    this.invalidateUsageCache();
    clearCustomSessionCache();
    this.discovered.delete(id);
    await this.store.deleteAgent(id);
    await this.refresh(true);
    return this.snapshot();
  }

  async session(agent: string, id: string) {
    return await this.store.get(agent, id) ?? this.sessions.find(s => s.agent === agent && s.sessionId === id);
  }

  async action(action: string, agent: string, id: string) {
    const session = await this.session(agent, id);
    if (!session) throw new Error("会话已不存在，请刷新列表。");
    if (action === "subscribe") await this.store.subscribeEntry(session);
    else if (action === "unsubscribe") await this.store.setSubscribed(agent, id, false);
    else if (action === "handled") await this.store.markHandled(agent, id);
    else if (action === "restore") await this.store.unmarkHandled(agent, id);
    else throw new Error("不支持的操作");
    await this.refresh();
    return this.snapshot();
  }

  async settings(patch: Record<string, unknown>) {
    const allowed: Partial<Config> = {};
    for (const key of ["notifications", "contentSearchEnabled"] as const) if (typeof patch[key] === "boolean") allowed[key] = patch[key];
    if (patch.theme !== undefined) {
      if (patch.theme !== "light" && patch.theme !== "dark" && patch.theme !== "system") throw new Error("不支持的外观选项");
      allowed.theme = patch.theme;
    }
    writeConfig(allowed);
    // Appearance changes should not wait for collectors or deliver notifications.
    if (allowed.theme && Object.keys(allowed).length === 1) { this.publish(); return this.snapshot(); }
    if (!readConfig().contentSearchEnabled) {this.indexQueue?.dispose(); this.indexQueue = undefined; this.indexState.busy = false;}
    await this.refresh();
    return this.snapshot();
  }

  connectionPlan(agent: string, operation: string) {
    const adapter = getAdapter(agent);
    if (!adapter) throw new Error("未知客户端");
    return operation === "remove" ? adapter.planUninstall() : adapter.planInstall(this.context);
  }

  async applyConnection(agent: string, operation: string) {
    const plan = this.connectionPlan(agent, operation);
    // Preserve every connection change backup, rather than overwriting a prior backup.
    for (const change of plan.changes) if (change.before && change.before !== change.after && existsSync(change.path))
      copyFileSync(change.path, `${change.path}.agent-inbox.${Date.now()}.bak`);
    const written = applyPlan(plan);
    await this.refresh(true);
    return written;
  }
}
