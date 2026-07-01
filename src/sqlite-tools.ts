import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";

// --- Pending SQLite Change Store ---

export interface SqliteWhereCondition {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "IS" | "IS NOT";
  value: string | number | null;
}

export interface SqliteInsertChange {
  type: "insert";
  table: string;
  columns: string[];
  values: (string | number | null)[];
}

export interface SqliteUpdateChange {
  type: "update";
  table: string;
  /** Column → value. Dot-separated keys (e.g. "job_json.enabled") do jsonSet on JSON text column. */
  set: Record<string, string | number | null>;
  /** WHERE conditions, joined with AND. Only simple column=value comparisons. */
  where: SqliteWhereCondition[];
  /** Row limit. Default 1. Max 100. */
  limit?: number;
  /** Fields to re-verify on confirm. Prevents stale-preview writes. */
  expected?: Record<string, unknown>;
}

export interface SqliteDeleteChange {
  type: "delete";
  table: string;
  where: SqliteWhereCondition[];
  limit?: number;
  expected?: Record<string, unknown>;
}

export type SqliteChange = SqliteInsertChange | SqliteUpdateChange | SqliteDeleteChange;

export interface PendingSqliteChange {
  id: string;
  dbPath: string;
  change: SqliteChange;
  beforeRows: Record<string, unknown>[];
  diff: string;
  createdAt: number;
}

// --- Store ---

class SqliteChangeStore {
  private readonly changes = new Map<string, PendingSqliteChange>();

  create(input: Omit<PendingSqliteChange, "id" | "createdAt">): PendingSqliteChange {
    const entry = { ...input, id: `sqlite_${randomUUID()}`, createdAt: Date.now() };
    this.changes.set(entry.id, entry);
    return entry;
  }

  take(actionId: string): PendingSqliteChange {
    const entry = this.changes.get(actionId);
    if (!entry) throw new Error(`Unknown sqlite actionId: ${actionId}`);
    this.changes.delete(actionId);
    return entry;
  }
}

export const sqliteChanges = new SqliteChangeStore();

// --- Constants ---

const allowedPragmas = new Set(["table_info", "table_list", "index_list", "index_info", "foreign_key_list"]);
const identifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const safeOperators = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS", "IS NOT"] as const;

// --- Public API — Status ---

export function sqliteStatus(config: Config) {
  return {
    enabled: config.sqliteToolsEnabled,
    allowedDbs: config.sqliteAllowedDbs,
    maxRows: config.sqliteMaxRows,
    nodeSqlite: true,
  };
}

// --- Public API — Schema ---

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

// --- Public API — Select ---

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

// --- Public API — Preview Change ---

export function sqlitePreviewChange(config: Config, input: {
  dbPath?: string;
  change: SqliteChange;
}) {
  const resolved = resolveAllowedDb(config, input.dbPath);
  validateChange(input.change);
  const db = openDb(resolved, true);
  try {
    const change = input.change;
    let beforeRows: Record<string, unknown>[] = [];
    let diff = "";

    switch (change.type) {
      case "insert": {
        const row = buildRowFromInsert(change);
        beforeRows = [];
        diff = `+ INSERT INTO ${quoteIdent(change.table)} (${change.columns.map(quoteIdent).join(", ")})\n  VALUES\n${JSON.stringify(row, null, 2)}`;
        break;
      }
      case "update": {
        beforeRows = fetchRowsForWhere(db, change.table, change.where, undefined);
        const setDisplay = Object.entries(change.set).map(([k, v]) => `  SET ${k} = ${JSON.stringify(v)}`).join("\n");
        const afterRows = beforeRows.map((row) => applySetToRow(row, change.set));
        diff = formatBeforeAfter(beforeRows, afterRows, change.table, "UPDATE", setDisplay);
        break;
      }
      case "delete": {
        beforeRows = fetchRowsForWhere(db, change.table, change.where, change.limit);
        diff = formatDeletePreview(beforeRows, change.table);
        break;
      }
    }

    const pending = sqliteChanges.create({
      dbPath: resolved,
      change,
      beforeRows,
      diff,
    });

    return { action: pending, beforeRows, diff };
  } finally {
    db.close();
  }
}

// --- Public API — Confirm Change ---

export function sqliteConfirmChange(config: Config, actionId: string) {
  const pending = sqliteChanges.take(actionId);
  const db = openDb(pending.dbPath, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const change = pending.change;

      switch (change.type) {
        case "insert": {
          const placeholders = change.columns.map(() => "?").join(", ");
          const sql = `INSERT INTO ${quoteIdent(change.table)} (${change.columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
          db.prepare(sql).run(...change.values);
          break;
        }

        case "update": {
          // Re-verify expected fields
          if (change.expected && Object.keys(change.expected).length > 0) {
            const current = fetchRowsForWhere(db, change.table, change.where, undefined);
            verifyExpected(current, change.expected);
          }

          const limit = Math.min(change.limit ?? 1, 100);
          const resolved = resolveSetAndWhere(change);
          const sql = buildUpdateSql(change.table, resolved, limit);
          const allParams = [...resolved.setParams, ...resolved.whereParams];
          db.prepare(sql).run(...allParams);
          break;
        }

        case "delete": {
          if (change.expected && Object.keys(change.expected).length > 0) {
            const current = fetchRowsForWhere(db, change.table, change.where, undefined);
            verifyExpected(current, change.expected);
          }

          const limit = Math.min(change.limit ?? 1, 100);
          const { whereClause, whereParams } = buildWhereClause(change.where);
          const sql = `DELETE FROM ${quoteIdent(change.table)}${whereClause ? ` WHERE ${whereClause}` : ""} LIMIT ${limit}`;
          db.prepare(sql).run(...whereParams);
          break;
        }
      }

      db.exec("COMMIT");
      return { applied: true, action_id: actionId, change_type: change.type, table: change.table };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

// --- Validation ---

function validateChange(change: SqliteChange): void {
  if (!change.table || !identifierRegex.test(change.table)) {
    throw new Error(`Invalid or unsafe table name: ${JSON.stringify(change.table)}`);
  }

  if (change.type === "insert") {
    if (!Array.isArray(change.columns) || change.columns.length === 0) {
      throw new Error("insert requires at least one column");
    }
    if (!Array.isArray(change.values) || change.values.length !== change.columns.length) {
      throw new Error("insert values array length must match columns array length");
    }
    for (const col of change.columns) {
      if (!identifierRegex.test(col)) throw new Error(`Invalid column name in insert: ${JSON.stringify(col)}`);
    }
    return;
  }

  if (change.type === "update") {
    if (!change.set || Object.keys(change.set).length === 0) {
      throw new Error("update requires at least one set field");
    }
    for (const key of Object.keys(change.set)) {
      const colPart = key.split(".")[0];
      if (!identifierRegex.test(colPart)) throw new Error(`Invalid column name in set: ${JSON.stringify(key)}`);
    }
    if (change.where) validateWhere(change.where);
    return;
  }

  if (change.type === "delete") {
    if (change.where) validateWhere(change.where);
    return;
  }

  throw new Error(`Unknown change type: ${(change as SqliteChange).type}`);
}

function validateWhere(where: SqliteWhereCondition[]): void {
  for (const cond of where) {
    if (!identifierRegex.test(cond.column)) {
      throw new Error(`Invalid column name in WHERE: ${JSON.stringify(cond.column)}`);
    }
    if (!(safeOperators as readonly string[]).includes(cond.operator)) {
      throw new Error(`Invalid WHERE operator: ${cond.operator}`);
    }
  }
}

// --- Identifier quoting ---

function quoteIdent(name: string): string {
  if (!identifierRegex.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

// --- WHERE clause builder ---

interface ResolvedWhere {
  whereClause: string;
  whereParams: (string | number | null)[];
}

function buildWhereClause(where: SqliteWhereCondition[]): ResolvedWhere {
  if (!where || where.length === 0) return { whereClause: "", whereParams: [] };

  const clauses: string[] = [];
  const params: (string | number | null)[] = [];

  for (const cond of where) {
    if (cond.operator === "IS" || cond.operator === "IS NOT") {
      clauses.push(`${quoteIdent(cond.column)} ${cond.operator} NULL`);
      // No param for IS NULL
    } else {
      clauses.push(`${quoteIdent(cond.column)} ${cond.operator} ?`);
      params.push(cond.value);
    }
  }

  return { whereClause: clauses.join(" AND "), whereParams: params };
}

// --- SET clause builder (handles jsonSet via dot-path) ---

interface ResolvedSet {
  setClauses: string[];
  setParams: (string | number | null)[];
}

function buildSetClause(set: Record<string, string | number | null>): ResolvedSet {
  const setClauses: string[] = [];
  const setParams: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(set)) {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) {
      // Regular column set
      setClauses.push(`${quoteIdent(key)} = ?`);
      setParams.push(value);
    } else {
      // jsonSet: column.json.path → json_set("column", '$.json.path', ?)
      const column = key.slice(0, dotIndex);
      const pathStr = key.slice(dotIndex + 1);
      const pathParts = pathStr.split(".");
      for (const part of pathParts) {
        if (!identifierRegex.test(part)) throw new Error(`Invalid JSON path segment in set key: ${JSON.stringify(key)}`);
      }
      const jsonPath = "$." + pathParts.join(".");
      setClauses.push(`${quoteIdent(column)} = json_set(${quoteIdent(column)}, '${jsonPath}', ?)`);
      setParams.push(value);
    }
  }

  return { setClauses, setParams };
}

// --- Combined resolve for UPDATE ---

interface ResolvedSetAndWhere {
  setClauses: string[];
  setParams: (string | number | null)[];
  whereClause: string;
  whereParams: (string | number | null)[];
}

function resolveSetAndWhere(change: SqliteUpdateChange): ResolvedSetAndWhere {
  const { setClauses, setParams } = buildSetClause(change.set);
  const { whereClause, whereParams } = buildWhereClause(change.where);
  return { setClauses, setParams, whereClause, whereParams };
}

// --- SQL builders ---

function buildUpdateSql(table: string, resolved: ResolvedSetAndWhere, limit: number): string {
  const parts = [`UPDATE ${quoteIdent(table)}`];
  parts.push(`SET ${resolved.setClauses.join(", ")}`);
  if (resolved.whereClause) parts.push(`WHERE ${resolved.whereClause}`);
  parts.push(`LIMIT ${limit}`);
  return parts.join(" ");
}

// --- Fetch rows for WHERE ---

function fetchRowsForWhere(
  db: DatabaseSync,
  table: string,
  where: SqliteWhereCondition[],
  limit: number | undefined,
): Record<string, unknown>[] {
  const { whereClause, whereParams } = buildWhereClause(where);
  const limitClause = limit !== undefined ? ` LIMIT ${Math.min(limit, 100)}` : "";
  const sql = `SELECT * FROM ${quoteIdent(table)}${whereClause ? ` WHERE ${whereClause}` : ""}${limitClause}`;
  const stmt = db.prepare(sql);
  return whereParams.length > 0 ? stmt.all(...whereParams) : stmt.all();
}

// --- Apply set to a row (for preview diff) ---

function applySetToRow(row: Record<string, unknown>, set: Record<string, string | number | null>): Record<string, unknown> {
  const result = { ...row };
  for (const [key, value] of Object.entries(set)) {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) {
      result[key] = value;
    } else {
      // jsonSet: parse the JSON column, set nested value, re-stringify
      const column = key.slice(0, dotIndex);
      const pathStr = key.slice(dotIndex + 1);
      const pathParts = pathStr.split(".");
      const raw = result[column];
      if (typeof raw === "string") {
        try {
          const obj = JSON.parse(raw);
          let current = obj;
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (current[pathParts[i]] === undefined || current[pathParts[i]] === null) {
              current[pathParts[i]] = {};
            }
            current = current[pathParts[i]];
          }
          current[pathParts[pathParts.length - 1]] = value;
          result[column] = JSON.stringify(obj);
        } catch {
          // If not valid JSON, fall back to setting the whole column
          result[column] = value;
        }
      } else {
        // Not a string, just set the whole column
        result[column] = value;
      }
    }
  }
  return result;
}

// --- Build row from insert ---

function buildRowFromInsert(change: SqliteInsertChange): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let i = 0; i < change.columns.length; i++) {
    row[change.columns[i]] = change.values[i];
  }
  return row;
}

// --- Expected fields verification ---

function verifyExpected(currentRows: Record<string, unknown>[], expected: Record<string, unknown>): void {
  if (currentRows.length === 0) throw new Error("Expected rows not found (no rows match WHERE clause)");
  for (const [key, expectedValue] of Object.entries(expected)) {
    for (let i = 0; i < currentRows.length; i++) {
      const actualVal = currentRows[i][key];
      if (actualVal !== expectedValue) {
        throw new Error(
          `Expected field mismatch on confirm: ${key} expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualVal)}. ` +
          "The row changed since preview. Run preview again.",
        );
      }
    }
  }
}

// --- Diff formatters ---

function formatBeforeAfter(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  table: string,
  operation: string,
  details: string,
): string {
  const lines: string[] = [];
  for (let i = 0; i < before.length; i++) {
    lines.push(`--- ${table} row ${i + 1} (before)`);
    lines.push(`+++ ${table} row ${i + 1} (after)`);
    for (const key of Object.keys({ ...before[i], ...after[i] })) {
      const bVal = JSON.stringify(before[i][key]);
      const aVal = JSON.stringify(after[i][key]);
      if (bVal !== aVal) {
        lines.push(`- ${key}: ${bVal}`);
        lines.push(`+ ${key}: ${aVal}`);
      }
    }
    if (i < before.length - 1) lines.push("---");
  }
  if (lines.length === 0) {
    lines.push(`(no rows match the WHERE condition for ${operation})`);
  }
  return lines.join("\n");
}

function formatDeletePreview(rows: Record<string, unknown>[], table: string): string {
  if (rows.length === 0) return `(no rows match the WHERE condition. Nothing will be deleted from ${table})`;
  const lines: string[] = [`DELETE from ${table}: ${rows.length} row(s) will be removed`];
  for (let i = 0; i < rows.length; i++) {
    lines.push(`  row ${i + 1}: ${JSON.stringify(rows[i])}`);
  }
  return lines.join("\n");
}

// --- DB helpers ---

function resolveAllowedDb(config: Config, dbPath?: string): string {
  if (!config.sqliteToolsEnabled) throw new Error("SQLite tools are disabled. Set CTM_SQLITE_TOOLS=1 to enable them.");
  if (config.sqliteAllowedDbs.length === 0) throw new Error("No SQLite databases are allowed. Set CTM_SQLITE_ALLOWED_DBS.");
  const target = resolve(dbPath ?? singleAllowedDb(config));
  if (!config.sqliteAllowedDbs.some((allowed) => resolve(allowed).toLowerCase() === target.toLowerCase())) {
    throw new Error(`SQLite database is not in CTM_SQLITE_ALLOWED_DBS: ${target}`);
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

type SqliteParam = string | number | bigint | null;
