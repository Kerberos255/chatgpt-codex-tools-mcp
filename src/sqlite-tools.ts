import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";

export interface PendingCronUpdate {
  id: string;
  dbPath: string;
  storeKey: string;
  jobId: string;
  patch: CronJobPatch;
  before: CronJobRow;
  after: CronJobRow;
  createdAt: number;
}

export interface CronJobPatch {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  scheduleKind?: string;
  scheduleExpr?: string | null;
  scheduleTz?: string | null;
  everyMs?: number | null;
  at?: string | null;
  staggerMs?: number | null;
  payloadMessage?: string | null;
  payloadModel?: string | null;
  payloadThinking?: string | null;
  payloadTimeoutSeconds?: number | null;
  deliveryMode?: string | null;
  deliveryChannel?: string | null;
  deliveryTo?: string | null;
  failureAlertDisabled?: boolean | null;
  failureAlertAfter?: number | null;
  failureAlertTo?: string | null;
}

export interface CronJobRow {
  store_key: string;
  job_id: string;
  name: string;
  description: string | null;
  enabled: number;
  schedule_kind: string;
  schedule_expr: string | null;
  schedule_tz: string | null;
  every_ms: number | null;
  at: string | null;
  stagger_ms: number | null;
  payload_message: string | null;
  payload_model: string | null;
  payload_thinking: string | null;
  payload_timeout_seconds: number | null;
  delivery_mode: string | null;
  delivery_channel: string | null;
  delivery_to: string | null;
  failure_alert_disabled: number | null;
  failure_alert_after: number | null;
  failure_alert_to: string | null;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_run_status: string | null;
  last_error: string | null;
  consecutive_errors: number | null;
  job_json: string;
  state_json: string;
  updated_at: number;
  [key: string]: unknown;
}

class CronUpdateStore {
  private readonly updates = new Map<string, PendingCronUpdate>();

  create(input: Omit<PendingCronUpdate, "id" | "createdAt">): PendingCronUpdate {
    const update = { ...input, id: `cron_${randomUUID()}`, createdAt: Date.now() };
    this.updates.set(update.id, update);
    return update;
  }

  take(actionId: string): PendingCronUpdate {
    const update = this.updates.get(actionId);
    if (!update) throw new Error(`Unknown cron actionId: ${actionId}`);
    this.updates.delete(actionId);
    return update;
  }
}

export const cronUpdates = new CronUpdateStore();

const allowedPragmas = new Set(["table_info", "table_list", "index_list", "index_info", "foreign_key_list"]);
const cronDiffKeys = [
  "name",
  "description",
  "enabled",
  "schedule_kind",
  "schedule_expr",
  "schedule_tz",
  "every_ms",
  "at",
  "stagger_ms",
  "payload_message",
  "payload_model",
  "payload_thinking",
  "payload_timeout_seconds",
  "delivery_mode",
  "delivery_channel",
  "delivery_to",
  "failure_alert_disabled",
  "failure_alert_after",
  "failure_alert_to",
] as const;

export function sqliteStatus(config: Config) {
  return {
    enabled: config.sqliteToolsEnabled,
    allowedDbs: config.sqliteAllowedDbs,
    maxRows: config.sqliteMaxRows,
    cronDbPath: config.cronDbPath,
    cronStoreKey: config.cronStoreKey,
    nodeSqlite: true,
  };
}

export function sqliteSchema(config: Config, dbPath?: string) {
  const resolved = resolveAllowedDb(config, dbPath);
  const db = openDb(resolved, true);
  try {
    return db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') ORDER BY type, name",
    ).all();
  } finally {
    db.close();
  }
}

export function sqliteSelect(config: Config, input: { dbPath?: string; sql: string; params?: SqliteParam[]; limit?: number }) {
  const resolved = resolveAllowedDb(config, input.dbPath);
  assertReadOnlySql(input.sql);
  const limit = Math.min(input.limit ?? config.sqliteMaxRows, config.sqliteMaxRows);
  const db = openDb(resolved, true);
  try {
    const statement = db.prepare(input.sql);
    const rows: Record<string, unknown>[] = [];
    for (const row of statement.iterate(...(input.params ?? []))) {
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  } finally {
    db.close();
  }
}

export function listCronJobs(config: Config, input: { dbPath?: string; storeKey?: string; includeDisabled?: boolean; limit?: number }) {
  const dbPath = resolveCronDb(config, input.dbPath);
  const storeKey = input.storeKey ?? config.cronStoreKey;
  const limit = Math.min(input.limit ?? config.sqliteMaxRows, config.sqliteMaxRows);
  const where: string[] = [];
  const params: SqliteParam[] = [];
  if (storeKey) {
    where.push("store_key = ?");
    params.push(storeKey);
  }
  if (!input.includeDisabled) where.push("enabled = 1");

  const sql = [
    "SELECT store_key, job_id, name, description, enabled, schedule_kind, schedule_expr, schedule_tz, every_ms, at, next_run_at_ms,",
    "last_run_at_ms, last_run_status, last_error, consecutive_errors, delivery_mode, delivery_channel, delivery_to, updated_at",
    "FROM cron_jobs",
    where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY sort_order ASC, updated_at DESC, job_id",
    "LIMIT ?",
  ].filter(Boolean).join(" ");
  params.push(limit);

  const db = openDb(dbPath, true);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function getCronJob(config: Config, input: { dbPath?: string; storeKey?: string; jobId: string }): CronJobRow {
  const dbPath = resolveCronDb(config, input.dbPath);
  const storeKey = input.storeKey ?? config.cronStoreKey;
  if (!storeKey) throw new Error("storeKey is required when CTM_CRON_STORE_KEY is not set.");
  const db = openDb(dbPath, true);
  try {
    const row = db.prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?").get(storeKey, input.jobId) as CronJobRow | undefined;
    if (!row) throw new Error(`Cron job not found: ${input.jobId}`);
    return row;
  } finally {
    db.close();
  }
}

export function previewCronUpdate(config: Config, input: { dbPath?: string; storeKey?: string; jobId: string; patch: CronJobPatch }) {
  const dbPath = resolveCronDb(config, input.dbPath);
  const storeKey = input.storeKey ?? config.cronStoreKey;
  if (!storeKey) throw new Error("storeKey is required when CTM_CRON_STORE_KEY is not set.");
  const before = getCronJob(config, { dbPath, storeKey, jobId: input.jobId });
  const after = applyCronPatch(before, input.patch);
  const diff = diffCronRows(before, after);
  const action = cronUpdates.create({ dbPath, storeKey, jobId: input.jobId, patch: input.patch, before, after });
  return { action, diff };
}

export function confirmCronUpdate(config: Config, actionId: string) {
  const action = cronUpdates.take(actionId);
  const db = openDb(action.dbPath, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?").get(action.storeKey, action.jobId) as CronJobRow | undefined;
      if (!current) throw new Error(`Cron job not found: ${action.jobId}`);
      if (current.updated_at !== action.before.updated_at) {
        throw new Error("Cron job changed after preview. Preview the update again before confirming.");
      }
      if (!hasCronDataChanges(action.before, action.after)) {
        db.exec("COMMIT");
        return current;
      }

      const after = { ...action.after, updated_at: Date.now() };
      db.prepare(
        [
          "UPDATE cron_jobs SET",
          "name = ?, description = ?, enabled = ?, schedule_kind = ?, schedule_expr = ?, schedule_tz = ?, every_ms = ?, at = ?, stagger_ms = ?,",
          "payload_message = ?, payload_model = ?, payload_thinking = ?, payload_timeout_seconds = ?,",
          "delivery_mode = ?, delivery_channel = ?, delivery_to = ?,",
          "failure_alert_disabled = ?, failure_alert_after = ?, failure_alert_to = ?,",
          "job_json = ?, updated_at = ?",
          "WHERE store_key = ? AND job_id = ?",
        ].join(" "),
      ).run(
        after.name,
        after.description,
        after.enabled,
        after.schedule_kind,
        after.schedule_expr,
        after.schedule_tz,
        after.every_ms,
        after.at,
        after.stagger_ms,
        after.payload_message,
        after.payload_model,
        after.payload_thinking,
        after.payload_timeout_seconds,
        after.delivery_mode,
        after.delivery_channel,
        after.delivery_to,
        after.failure_alert_disabled,
        after.failure_alert_after,
        after.failure_alert_to,
        after.job_json,
        after.updated_at,
        action.storeKey,
        action.jobId,
      );
      const updated = db.prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?").get(action.storeKey, action.jobId) as CronJobRow | undefined;
      db.exec("COMMIT");
      return updated ?? after;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function applyCronPatch(row: CronJobRow, patch: CronJobPatch): CronJobRow {
  const after = { ...row };
  const jobJson = parseJobJson(row.job_json);

  setIfDefined(after, "name", patch.name);
  setIfDefined(after, "description", patch.description);
  if (patch.enabled !== undefined) after.enabled = patch.enabled ? 1 : 0;
  setIfDefined(after, "schedule_kind", patch.scheduleKind);
  setIfDefined(after, "schedule_expr", patch.scheduleExpr);
  setIfDefined(after, "schedule_tz", patch.scheduleTz);
  setIfDefined(after, "every_ms", patch.everyMs);
  setIfDefined(after, "at", patch.at);
  setIfDefined(after, "stagger_ms", patch.staggerMs);
  setIfDefined(after, "payload_message", patch.payloadMessage);
  setIfDefined(after, "payload_model", patch.payloadModel);
  setIfDefined(after, "payload_thinking", patch.payloadThinking);
  setIfDefined(after, "payload_timeout_seconds", patch.payloadTimeoutSeconds);
  setIfDefined(after, "delivery_mode", patch.deliveryMode);
  setIfDefined(after, "delivery_channel", patch.deliveryChannel);
  setIfDefined(after, "delivery_to", patch.deliveryTo);
  if (patch.failureAlertDisabled !== undefined) after.failure_alert_disabled = patch.failureAlertDisabled === null ? null : patch.failureAlertDisabled ? 1 : 0;
  setIfDefined(after, "failure_alert_after", patch.failureAlertAfter);
  setIfDefined(after, "failure_alert_to", patch.failureAlertTo);

  const nextJobJson = updateJobJson(jobJson, patch);
  after.job_json = nextJobJson === row.job_json ? row.job_json : nextJobJson;
  after.updated_at = hasCronDataChanges(row, after) ? Date.now() : row.updated_at;
  return after;
}

function updateJobJson(jobJson: Record<string, unknown>, patch: CronJobPatch): string {
  assignJson(jobJson, "name", patch.name);
  assignJson(jobJson, "description", patch.description);
  assignJson(jobJson, "enabled", patch.enabled);

  if (hasDefined(patch.scheduleKind, patch.scheduleExpr, patch.scheduleTz, patch.everyMs, patch.at, patch.staggerMs)) {
    const schedule = ensureObject(jobJson, "schedule");
    assignJson(schedule, "kind", patch.scheduleKind);
    assignJson(schedule, "expr", patch.scheduleExpr);
    assignJson(schedule, "tz", patch.scheduleTz);
    assignJson(schedule, "everyMs", patch.everyMs);
    assignJson(schedule, "at", patch.at);
    assignJson(schedule, "staggerMs", patch.staggerMs);
  }

  if (hasDefined(patch.payloadMessage, patch.payloadModel, patch.payloadThinking, patch.payloadTimeoutSeconds)) {
    const payload = ensureObject(jobJson, "payload");
    assignJson(payload, "message", patch.payloadMessage);
    assignJson(payload, "model", patch.payloadModel);
    assignJson(payload, "thinking", patch.payloadThinking);
    assignJson(payload, "timeoutSeconds", patch.payloadTimeoutSeconds);
  }

  if (hasDefined(patch.deliveryMode, patch.deliveryChannel, patch.deliveryTo)) {
    const delivery = ensureObject(jobJson, "delivery");
    assignJson(delivery, "mode", patch.deliveryMode);
    assignJson(delivery, "channel", patch.deliveryChannel);
    assignJson(delivery, "to", patch.deliveryTo);
  }

  if (hasDefined(patch.failureAlertDisabled, patch.failureAlertAfter, patch.failureAlertTo)) {
    const failureAlert = ensureObject(jobJson, "failureAlert");
    assignJson(failureAlert, "disabled", patch.failureAlertDisabled);
    assignJson(failureAlert, "after", patch.failureAlertAfter);
    assignJson(failureAlert, "to", patch.failureAlertTo);
  }

  return JSON.stringify(jobJson);
}

function diffCronRows(before: CronJobRow, after: CronJobRow): string {
  const lines: string[] = [];
  for (const key of cronDiffKeys) {
    if (before[key] !== after[key]) {
      lines.push(`- ${key}: ${formatValue(before[key])}`);
      lines.push(`+ ${key}: ${formatValue(after[key])}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no changes)";
}

function resolveCronDb(config: Config, dbPath?: string): string {
  const target = dbPath ?? config.cronDbPath;
  if (!target) throw new Error("CTM_CRON_DB_PATH is not configured.");
  return resolveAllowedDb(config, target);
}

function resolveAllowedDb(config: Config, dbPath?: string): string {
  if (!config.sqliteToolsEnabled) throw new Error("SQLite tools are disabled. Set CTM_SQLITE_TOOLS=1 to enable them.");
  if (config.sqliteAllowedDbs.length === 0) throw new Error("No SQLite databases are allowed. Set CTM_SQLITE_ALLOWED_DBS.");
  const target = resolve(dbPath ?? singleAllowedDb(config));
  if (!config.sqliteAllowedDbs.some((allowed) => resolve(allowed).toLowerCase() === target.toLowerCase())) {
    throw new Error(`SQLite database is not in CTM_SQLITE_ALLOWED_DBS: ${dbPath ?? target}`);
  }
  if (!existsSync(target)) throw new Error(`SQLite database does not exist: ${target}`);
  return target;
}

function singleAllowedDb(config: Config): string {
  if (config.sqliteAllowedDbs.length !== 1) throw new Error("dbPath is required when multiple SQLite databases are allowed.");
  return config.sqliteAllowedDbs[0];
}

function openDb(path: string, readOnly: boolean): DatabaseSync {
  return new DatabaseSync(path, { readOnly, timeout: 5000 });
}

function assertReadOnlySql(sql: string) {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("SQL must not be empty.");
  if (trimmed.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (/^(select|with)\b/i.test(trimmed)) return;
  const pragma = /^pragma\s+([a-z_]+)/i.exec(trimmed);
  if (pragma && allowedPragmas.has(pragma[1].toLowerCase())) return;
  throw new Error("Only SELECT/WITH and safe PRAGMA statements are allowed.");
}

function parseJobJson(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cron job_json is not an object.");
  return parsed as Record<string, unknown>;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function assignJson(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
}

function hasDefined(...values: unknown[]): boolean {
  return values.some((value) => value !== undefined);
}

function setIfDefined<T extends Record<string, unknown>, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) target[key] = value;
}

function hasCronDataChanges(before: CronJobRow, after: CronJobRow): boolean {
  return before.job_json !== after.job_json || cronDiffKeys.some((key) => before[key] !== after[key]);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value.length > 400 ? `${value.slice(0, 400)}...` : value);
  return JSON.stringify(value);
}

type SqliteParam = string | number | bigint | null;
