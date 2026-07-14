#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = path.resolve(process.argv[1]);
const PACKAGE_VERSION = require("../package.json").version;
const FORMAT_VERSION = 1;
const PROTOCOL_REVISION = 3;
const DEFAULT_EXCLUDES = [".system", ".git", "node_modules", "__pycache__", ".DS_Store"];
const CONFIG_ROOT = process.env.CODEX_SYNC_HOME
  ? expandPath(process.env.CODEX_SYNC_HOME)
  : path.join(os.homedir(), ".codex-sync");

class CodexSyncError extends Error {}

function stripWindowsExtendedPrefix(input) {
  const value = String(input);
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\/i.test(value)) return value.slice(4);
  return value;
}

function normalizeFsPath(input) {
  return path.resolve(stripWindowsExtendedPrefix(input));
}

function expandPath(input) {
  if (!input) return input;
  const envExpanded = input.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? _)
    .replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? _);
  if (envExpanded === "~") return os.homedir();
  if (envExpanded.startsWith("~/") || envExpanded.startsWith("~\\")) {
    return path.join(os.homedir(), envExpanded.slice(2));
  }
  return normalizeFsPath(envExpanded);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (["json", "dry-run", "quiet", "force", "no-sync", "help", "all", "no-tasks", "register", "no-register"].includes(rawKey)) {
      options[rawKey] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const next = inline !== undefined ? inline : argv[++i];
    if (next === undefined || next.startsWith("--")) throw new CodexSyncError(`Missing value for --${rawKey}`);
    if (["exclude", "ignore", "share-with"].includes(rawKey)) options[rawKey] = [...(options[rawKey] ?? []), next];
    else options[rawKey] = next;
  }
  return { positional, options };
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  const result = String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new CodexSyncError(`Invalid portable name: ${value}`);
  return result.slice(0, 64);
}

function mkdir(dir, dryRun = false) {
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new CodexSyncError(`Cannot read JSON ${file}: ${error.message}`);
  }
}

function atomicWrite(file, content, dryRun = false) {
  if (dryRun) return;
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    const current = fs.readFileSync(file);
    if (current.equals(next)) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, next);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    fs.renameSync(temp, file);
  }
  return true;
}

function writeJson(file, value, dryRun = false) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, dryRun);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(file) {
  return hashBuffer(fs.readFileSync(file));
}

function isPrefix(shorter, longer) {
  return shorter.length <= longer.length && longer.subarray(0, shorter.length).equals(shorter);
}

function portableRelative(root, file) {
  const normalizedRoot = normalizeFsPath(root);
  const normalizedFile = normalizeFsPath(file);
  const relative = path.relative(normalizedRoot, normalizedFile).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new CodexSyncError(`Path escapes root: ${file}`);
  }
  return relative;
}

function safeJoin(root, relative) {
  const normalized = relative.split("/").join(path.sep);
  const normalizedRoot = normalizeFsPath(root);
  const result = normalizeFsPath(path.join(normalizedRoot, normalized));
  const expected = `${normalizedRoot}${path.sep}`;
  const sameRoot = process.platform === "win32"
    ? result.toLowerCase() === normalizedRoot.toLowerCase()
    : result === normalizedRoot;
  const insideRoot = process.platform === "win32"
    ? result.toLowerCase().startsWith(expected.toLowerCase())
    : result.startsWith(expected);
  if (!sameRoot && !insideRoot) {
    throw new CodexSyncError(`Unsafe relative path: ${relative}`);
  }
  return result;
}

function completeJsonlSnapshot(file) {
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8");
  const parts = text.split("\n");
  const complete = [];
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i].endsWith("\r") ? parts[i].slice(0, -1) : parts[i];
    if (!line) continue;
    try {
      JSON.parse(line);
      complete.push(line);
    } catch (error) {
      const isLast = i === parts.length - 1;
      if (!isLast) throw new CodexSyncError(`Invalid JSONL before final line in ${file}: ${error.message}`);
    }
  }
  if (!complete.length) throw new CodexSyncError(`No complete JSONL records in ${file}`);
  return Buffer.from(`${complete.join("\n")}\n`, "utf8");
}

function auditJsonlBuffer(buffer) {
  const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
  const calls = new Map();
  const outputs = new Set();
  const startedTurns = [];
  const startedTurnEvents = [];
  const closedTurns = new Set();
  const latestTurnAbortEvents = new Map();
  let finalAnswers = 0;
  let userMessages = 0;
  let lastTimestamp = null;
  for (let index = 0; index < lines.length; index += 1) {
    const event = JSON.parse(lines[index]);
    const payload = event.payload ?? {};
    lastTimestamp = event.timestamp ?? lastTimestamp;
    const turnId = payload.turn_id ?? payload.internal_chat_message_metadata_passthrough?.turn_id ?? null;
    if (event.type === "event_msg" && payload.type === "task_started" && payload.turn_id) {
      startedTurns.push(payload.turn_id);
      startedTurnEvents.push({ turnId: payload.turn_id, line: index + 1, startedAt: payload.started_at ?? null });
    }
    if (event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(payload.type) && payload.turn_id) {
      closedTurns.add(payload.turn_id);
      if (payload.type === "turn_aborted") {
        latestTurnAbortEvents.set(payload.turn_id, {
          turnId: payload.turn_id,
          line: index + 1,
          reason: payload.reason ?? null,
          completedAt: payload.completed_at ?? null,
          durationMs: payload.duration_ms ?? null,
          projectionCompatible: payload.reason === "interrupted"
            && Number.isFinite(payload.completed_at)
            && Number.isFinite(payload.duration_ms),
        });
      }
    }
    if ((payload.type === "custom_tool_call" || payload.type === "function_call") && payload.call_id) {
      calls.set(payload.call_id, { callId: payload.call_id, kind: payload.type, line: index + 1, turnId });
    }
    if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && payload.call_id) outputs.add(payload.call_id);
    if (payload.phase === "final_answer") finalAnswers += 1;
    if (payload.type === "user_message" || (payload.type === "message" && payload.role === "user")) userMessages += 1;
  }
  const danglingCalls = [...calls.values()].filter((item) => !outputs.has(item.callId));
  const openTurns = startedTurns.filter((turnId) => !closedTurns.has(turnId));
  const latestTurnId = startedTurns.at(-1) ?? null;
  const staleOpenTurns = openTurns.filter((turnId) => turnId !== latestTurnId);
  const activeDanglingCalls = danglingCalls.filter((item) => latestTurnId && item.turnId === latestTurnId && openTurns.includes(latestTurnId));
  const tailDanglingCalls = danglingCalls.filter((item) => item.line === lines.length);
  const persistentDanglingCalls = danglingCalls.filter((item) => !activeDanglingCalls.some((active) => active.callId === item.callId));
  const projectionUnsafeAbortEvents = [...latestTurnAbortEvents.values()].filter((item) => !item.projectionCompatible);
  return {
    lines: lines.length,
    bytes: buffer.length,
    sha256: hashBuffer(buffer),
    lastTimestamp,
    finalAnswers,
    userMessages,
    startedTurnEvents,
    danglingCalls,
    activeDanglingCalls,
    tailDanglingCalls,
    persistentDanglingCalls,
    projectionUnsafeAbortEvents,
    openTurns,
    staleOpenTurns,
    latestTurnId,
    semanticOk: persistentDanglingCalls.length === 0 && staleOpenTurns.length === 0 && projectionUnsafeAbortEvents.length === 0,
    stable: danglingCalls.length === 0 && openTurns.length === 0 && projectionUnsafeAbortEvents.length === 0,
  };
}

function auditJsonlFile(file) {
  const snapshot = completeJsonlSnapshot(file);
  return { file: normalizeFsPath(file), ...auditJsonlBuffer(snapshot) };
}

function stableConversationSnapshot(file) {
  const full = completeJsonlSnapshot(file);
  const fullAudit = auditJsonlBuffer(full);
  if (fullAudit.stable) return { snapshot: full, audit: fullAudit, checkpoint: false };
  if (fullAudit.openTurns.length !== 1 || fullAudit.staleOpenTurns.length) return { snapshot: null, audit: fullAudit, checkpoint: false };
  const currentTurnId = fullAudit.openTurns[0];
  const start = [...fullAudit.startedTurnEvents].reverse().find((item) => item.turnId === currentTurnId);
  if (!start || start.line <= 1) return { snapshot: null, audit: fullAudit, checkpoint: false };
  const lines = full.toString("utf8").split(/\r?\n/).filter(Boolean);
  const checkpoint = Buffer.from(`${lines.slice(0, start.line - 1).join("\n")}\n`, "utf8");
  const checkpointAudit = auditJsonlBuffer(checkpoint);
  if (!checkpointAudit.stable) return { snapshot: null, audit: fullAudit, checkpointAudit, checkpoint: false };
  return { snapshot: checkpoint, audit: fullAudit, checkpointAudit, checkpoint: true };
}

function walkFiles(root, excludes = []) {
  if (!fs.existsSync(root)) return new Map();
  const excluded = new Set([...DEFAULT_EXCLUDES, ...excludes]);
  const result = new Map();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.includes(".codex-sync-conflict-")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.set(portableRelative(root, full), { file: full, hash: hashFile(full) });
    }
  };
  visit(root);
  return result;
}

function assertPortableCaseUnique(files, label) {
  const seen = new Map();
  for (const relative of files.keys()) {
    const portableKey = relative.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(portableKey);
    if (previous && previous !== relative) {
      throw new CodexSyncError(`Case/Unicode path collision in ${label}: ${previous} <> ${relative}`);
    }
    seen.set(portableKey, relative);
  }
}

function copyAtomic(source, destination, dryRun = false) {
  atomicWrite(destination, fs.readFileSync(source), dryRun);
}

function detectCodexHome(options = {}) {
  return expandPath(options["codex-home"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function configPath(options = {}) {
  return expandPath(options.config ?? process.env.CODEX_SYNC_CONFIG ?? path.join(CONFIG_ROOT, "config.json"));
}

function loadConfig(options = {}) {
  const file = configPath(options);
  const config = readJson(file);
  if (config.version !== FORMAT_VERSION) throw new CodexSyncError(`Unsupported config version ${config.version}`);
  config.vault = expandPath(config.vault);
  config.codexHome = expandPath(config.codexHome);
  config.skillSources = (config.skillSources ?? []).map((item) => ({ ...item, path: expandPath(item.path) }));
  Object.defineProperty(config, "_configFile", { value: file, enumerable: false, writable: true });
  return { config, file };
}

function saveConfig(file, config, dryRun = false) {
  const serializable = {
    ...config,
    vault: path.resolve(config.vault),
    codexHome: path.resolve(config.codexHome),
    skillSources: config.skillSources.map((item) => ({ ...item, path: path.resolve(item.path) })),
  };
  writeJson(file, serializable, dryRun);
}

function deviceId(requested) {
  if (requested) return slug(requested);
  const host = slug(os.hostname() || os.platform());
  return `${host}-${crypto.randomBytes(3).toString("hex")}`;
}

function commonSkillRoots(codexHome) {
  const candidates = [
    { name: "codex", path: path.join(codexHome, "skills"), excludes: [".system"] },
    { name: "agents", path: path.join(os.homedir(), ".agents", "skills"), excludes: [] },
    { name: "hermes", path: path.join(os.homedir(), ".hermes", "skills"), excludes: [] },
    { name: "hermes-config", path: path.join(os.homedir(), ".config", "hermes", "skills"), excludes: [] },
    { name: "hermes-macos", path: path.join(os.homedir(), "Library", "Application Support", "Hermes", "skills"), excludes: [] },
  ];
  return candidates.filter((item, index) => fs.existsSync(item.path)
    && candidates.findIndex((other) => path.resolve(other.path) === path.resolve(item.path)) === index);
}

function sqliteApi() {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}

function openDatabase(file, readOnly = false) {
  const api = sqliteApi();
  if (!api || !fs.existsSync(file)) return null;
  try {
    const db = new api.DatabaseSync(file, { readOnly });
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  } catch (error) {
    throw new CodexSyncError(`Cannot open SQLite ${file}: ${error.message}`);
  }
}

function listThreads(codexHome) {
  const dbFile = path.join(codexHome, "state_5.sqlite");
  const db = openDatabase(dbFile, true);
  if (db) {
    try {
      return db.prepare("SELECT id,title,rollout_path,created_at,updated_at,cwd,archived FROM threads ORDER BY updated_at DESC").all();
    } finally { db.close(); }
  }
  const index = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(index)) return [];
  return fs.readFileSync(index, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function findRollout(codexHome, id) {
  const db = openDatabase(path.join(codexHome, "state_5.sqlite"), true);
  if (db) {
    try {
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(id);
      const rolloutPath = row?.rollout_path ? normalizeFsPath(row.rollout_path) : null;
      if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
    } finally { db.close(); }
  }
  const sessions = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessions)) return null;
  const stack = [sessions];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) return full;
    }
  }
  return null;
}

function threadRow(codexHome, id) {
  const db = openDatabase(path.join(codexHome, "state_5.sqlite"), true);
  if (!db) return null;
  try { return db.prepare("SELECT * FROM threads WHERE id=?").get(id) ?? null; }
  finally { db.close(); }
}

function firstEventMetadata(snapshot) {
  const first = snapshot.toString("utf8").split("\n").find(Boolean);
  const parsed = JSON.parse(first);
  return { timestamp: parsed.timestamp, ...(parsed.payload ?? {}) };
}

function resolveThread(config, selector) {
  const candidate = selector === "current" ? process.env.CODEX_THREAD_ID : selector;
  if (!candidate) throw new CodexSyncError("Current thread ID is unavailable; pass a title fragment or thread ID.");
  const threads = listThreads(config.codexHome);
  const exact = threads.find((item) => item.id === candidate);
  if (exact) return exact;
  const query = candidate.toLowerCase();
  const matches = threads.filter((item) => String(item.title ?? item.thread_name ?? "").toLowerCase().includes(query));
  if (matches.length === 1) return matches[0];
  if (!matches.length && /^[0-9a-f-]{20,}$/i.test(candidate) && findRollout(config.codexHome, candidate)) {
    return { id: candidate, title: candidate };
  }
  if (!matches.length) throw new CodexSyncError(`No local thread matches: ${selector}`);
  throw new CodexSyncError(`Ambiguous thread selector (${matches.length} matches): ${matches.slice(0, 5).map((x) => `${x.id} ${x.title ?? x.thread_name}`).join(" | ")}`);
}

function applyPathMaps(value, maps = []) {
  if (!value) return value;
  const portableValue = stripWindowsExtendedPrefix(String(value)).replaceAll("\\", "/").replace(/\/+$/, "");
  const ordered = [...maps].sort((a, b) => String(b.from).length - String(a.from).length);
  for (const mapping of ordered) {
    const from = stripWindowsExtendedPrefix(String(mapping.from)).replaceAll("\\", "/").replace(/\/+$/, "");
    const lowerValue = portableValue.toLowerCase();
    const lowerFrom = from.toLowerCase();
    if (lowerValue !== lowerFrom && !lowerValue.startsWith(`${lowerFrom}/`)) continue;
    const suffix = portableValue.slice(from.length).replace(/^\/+/, "");
    return suffix ? path.join(expandPath(String(mapping.to)), ...suffix.split("/")) : expandPath(String(mapping.to));
  }
  return value;
}

function ensureThreadIndex(codexHome, metadata, rolloutPath, dryRun = false) {
  const row = metadata.row ?? {};
  const id = metadata.id;
  const created = Number(row.created_at ?? Math.floor(Date.parse(metadata.createdAt ?? nowIso()) / 1000));
  const updated = Number(row.updated_at ?? created);
  const title = String(metadata.title ?? row.title ?? id).trim() || id;
  const values = {
    id,
    rollout_path: normalizeFsPath(rolloutPath),
    created_at: created,
    updated_at: updated,
    source: row.source ?? "cli",
    model_provider: row.model_provider ?? metadata.modelProvider ?? "openai",
    cwd: normalizeFsPath(applyPathMaps(row.cwd ?? metadata.cwd ?? os.homedir(), metadata.pathMaps ?? [])),
    title,
    sandbox_policy: row.sandbox_policy ?? "{\"type\":\"danger-full-access\"}",
    approval_mode: row.approval_mode ?? "never",
    tokens_used: Number(row.tokens_used ?? 0),
    has_user_event: Number(metadata.hasUserEvent ?? row.has_user_event ?? 1),
    archived: Number(row.archived ?? 0),
    cli_version: row.cli_version ?? metadata.cliVersion ?? "",
    first_user_message: row.first_user_message ?? "",
    preview: metadata.preview ?? row.preview ?? row.first_user_message ?? title,
    recency_at: Number(row.recency_at ?? updated),
    recency_at_ms: Number(row.recency_at_ms ?? updated * 1000),
    created_at_ms: Number(row.created_at_ms ?? created * 1000),
    updated_at_ms: Number(row.updated_at_ms ?? updated * 1000),
  };
  if (!dryRun) {
    const db = openDatabase(path.join(codexHome, "state_5.sqlite"), false);
    if (db) {
      try {
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
        if (table) {
          const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((item) => item.name));
          const picked = Object.entries({ ...row, ...values }).filter(([key, value]) => columns.has(key) && value !== undefined);
          const names = picked.map(([key]) => key);
          const placeholders = names.map(() => "?").join(",");
          const updates = ["rollout_path", "updated_at", "updated_at_ms", "title", "preview", "recency_at", "recency_at_ms", "has_user_event"]
            .filter((key) => names.includes(key)).map((key) => `${key}=excluded.${key}`).join(",");
          db.prepare(`INSERT INTO threads (${names.join(",")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`)
            .run(...picked.map(([, value]) => value));
        }
      } finally { db.close(); }
    }
  }
  const indexFile = path.join(codexHome, "session_index.jsonl");
  const existing = fs.existsSync(indexFile)
    ? fs.readFileSync(indexFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    : [];
  const next = existing.filter((item) => item.id !== id);
  next.push({ id, thread_name: values.title, updated_at: new Date(updated * 1000).toISOString() });
  atomicWrite(indexFile, `${next.map((item) => JSON.stringify(item)).join("\n")}\n`, dryRun);
  if (!dryRun) updateLocalThreadCatalog(codexHome, values);
}

function updateLocalThreadCatalog(codexHome, values) {
  const file = path.join(codexHome, "sqlite", "codex-dev.db");
  const db = openDatabase(file, false);
  if (!db) return false;
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_thread_catalog'").get();
    if (!table) return false;
    const result = db.prepare("UPDATE local_thread_catalog SET display_title=?, source_updated_at=?, cwd=?, missing_candidate=0 WHERE thread_id=?")
      .run(values.title, values.updated_at, values.cwd, values.id);
    let changed = Number(result.changes ?? 0) > 0;
    if (!changed) {
      const hostsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_thread_catalog_hosts'").get();
      const localHost = hostsTable ? db.prepare("SELECT host_id FROM local_thread_catalog_hosts WHERE host_kind='local' ORDER BY host_id LIMIT 1").get() : null;
      if (localHost) {
        const syncTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_thread_catalog_sync_state'").get();
        const syncState = syncTable ? db.prepare("SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id=?").get(localHost.host_id) : null;
        const inserted = db.prepare("INSERT OR IGNORE INTO local_thread_catalog (host_id,thread_id,display_title,source_created_at,source_updated_at,cwd,source_kind,source_detail,model_provider,git_branch,observation_sequence,missing_candidate) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)")
          .run(localHost.host_id, values.id, values.title, values.created_at, values.updated_at, values.cwd, values.source ?? "vscode", null, values.model_provider, values.git_branch ?? null, Number(syncState?.observation_sequence ?? 0));
        changed = Number(inserted.changes ?? 0) > 0;
      }
    }
    if (changed) {
      const metadataTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_thread_catalog_metadata'").get();
      if (metadataTable) db.prepare("UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1").run();
      return true;
    }
    return false;
  } finally { db.close(); }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw new CodexSyncError(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new CodexSyncError(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function commandOutput(command, args, options = {}) {
  return run(command, args, options).stdout.trim();
}

function syncthingCandidates(config, options = {}) {
  const candidates = [
    options["syncthing-exe"],
    config.syncthing?.executable,
    process.env.SYNCTHING_EXE,
  ];
  if (process.platform === "win32") {
    candidates.push(
      path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "syncthing.exe"),
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Syncthing", "syncthing.exe"),
    );
    const found = run("where.exe", ["syncthing.exe"], { allowFailure: true });
    if (found.status === 0) candidates.push(...found.stdout.split(/\r?\n/));
  } else {
    candidates.push("/opt/homebrew/bin/syncthing", "/usr/local/bin/syncthing", "/usr/bin/syncthing");
    const found = run("which", ["syncthing"], { allowFailure: true });
    if (found.status === 0) candidates.push(...found.stdout.split(/\r?\n/));
  }
  return [...new Set(candidates.filter(Boolean).map((item) => expandPath(String(item).trim())))];
}

function findSyncthing(config, options = {}) {
  for (const candidate of syncthingCandidates(config, options)) {
    if (!fs.existsSync(candidate)) continue;
    const check = run(candidate, ["--version"], { allowFailure: true });
    if (check.status === 0) return candidate;
  }
  throw new CodexSyncError("Syncthing executable was not found. Run: codexsync syncthing configure --exe <path>");
}

function stCli(executable, args, options = {}) {
  return commandOutput(executable, ["cli", ...args], options);
}

function stLines(executable, args) {
  const output = stCli(executable, args);
  return output ? output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
}

function stJson(executable, args) {
  const output = stCli(executable, args);
  try { return JSON.parse(output); }
  catch (error) { throw new CodexSyncError(`Syncthing returned invalid JSON for ${args.join(" ")}: ${error.message}`); }
}

function syncthingInventory(executable) {
  const system = stJson(executable, ["show", "system"]);
  const devices = stLines(executable, ["config", "devices", "list"]).map((id) => {
    const name = stCli(executable, ["config", "devices", id, "name", "get"], { allowFailure: true }) || id;
    return { id, name, self: id === system.myID };
  });
  const folders = stLines(executable, ["config", "folders", "list"]).map((id) => stJson(executable, ["config", "folders", id, "dump-json"]));
  return { myID: system.myID, devices, folders };
}

function normalizedPath(value) {
  const resolved = path.resolve(expandPath(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathContains(parent, child) {
  const a = normalizedPath(parent);
  const b = normalizedPath(child);
  return b === a || b.startsWith(`${a}${path.sep}`);
}

function projectFolderId(projectPath, requested) {
  if (requested) return slug(requested);
  const base = slug(path.basename(projectPath));
  const fingerprint = crypto.createHash("sha256").update(normalizedPath(projectPath)).digest("hex").slice(0, 8);
  return `project-${base}-${fingerprint}`.slice(0, 64);
}

function selectSyncthingDevices(inventory, requested = []) {
  const remotes = inventory.devices.filter((device) => !device.self);
  const selectors = requested.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  if (!selectors.length || selectors.some((item) => item.toLowerCase() === "all")) return remotes;
  if (selectors.some((item) => item.toLowerCase() === "none")) return [];
  const result = [];
  for (const selector of selectors) {
    const lower = selector.toLowerCase();
    const matches = remotes.filter((device) => device.id.toLowerCase() === lower || device.name.toLowerCase() === lower
      || device.id.toLowerCase().startsWith(lower) || device.name.toLowerCase().includes(lower));
    if (matches.length !== 1) throw new CodexSyncError(`Syncthing device selector '${selector}' matched ${matches.length} devices.`);
    if (!result.some((item) => item.id === matches[0].id)) result.push(matches[0]);
  }
  return result;
}

function syncthingConfigFile(config) {
  const explicit = config.syncthing?.configFile;
  const candidates = [
    explicit,
    process.env.STCONFDIR ? path.join(process.env.STCONFDIR, "config.xml") : null,
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Syncthing", "config.xml") : null,
    process.platform === "win32" ? path.join(process.env.APPDATA ?? "", "Syncthing", "config.xml") : null,
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Syncthing", "config.xml") : null,
    path.join(os.homedir(), ".config", "syncthing", "config.xml"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function decodeXml(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
}

function syncthingRestCredentials(config) {
  const file = syncthingConfigFile(config);
  if (!file) throw new CodexSyncError("Syncthing config.xml was not found; REST status/rescan is unavailable.");
  const xml = fs.readFileSync(file, "utf8");
  const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  const address = decodeXml(xml.match(/<gui[^>]*>[\s\S]*?<address>([^<]+)<\/address>/)?.[1] ?? "127.0.0.1:8384");
  if (!apiKey) throw new CodexSyncError(`Syncthing API key is missing in ${file}`);
  const host = address.startsWith("http") ? address : `http://${address.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  return { file, apiKey, base: `${host.replace(/\/$/, "")}/rest` };
}

async function syncthingRest(config, endpoint, options = {}) {
  const credentials = syncthingRestCredentials(config);
  const response = await fetch(`${credentials.base}${endpoint}`, {
    method: options.method ?? "GET",
    headers: { "X-API-Key": credentials.apiKey, "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new CodexSyncError(`Syncthing REST ${endpoint} failed: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function resolveProjectFolder(inventory, selector) {
  if (!selector) throw new CodexSyncError("A project folder ID or path is required.");
  const normalized = normalizedPath(selector);
  const matches = inventory.folders.filter((folder) => folder.id === selector || normalizedPath(folder.path) === normalized || folder.label === selector);
  if (matches.length !== 1) throw new CodexSyncError(`Project selector '${selector}' matched ${matches.length} Syncthing folders.`);
  return matches[0];
}

function projectThreads(config, projectPath) {
  return listThreads(config.codexHome).filter((thread) => {
    if (Number(thread.archived ?? 0) !== 0 || !thread.cwd) return false;
    const localAbsolute = process.platform === "win32"
      ? path.win32.isAbsolute(stripWindowsExtendedPrefix(thread.cwd))
      : path.posix.isAbsolute(String(thread.cwd));
    if (!localAbsolute) return false;
    try { return pathContains(projectPath, thread.cwd); } catch { return false; }
  });
}

function selectProjectThreads(config, projectPath, selected = true) {
  const changedAt = nowIso();
  const threads = projectThreads(config, projectPath);
  for (const thread of threads) {
    config.conversations[thread.id] = {
      selected,
      updatedAt: changedAt,
      title: thread.title ?? thread.thread_name ?? thread.id,
      deviceId: config.deviceId,
      projectPath: path.resolve(projectPath),
    };
  }
  return threads.map((thread) => ({ id: thread.id, title: thread.title ?? thread.thread_name ?? thread.id, cwd: thread.cwd }));
}

function codexProjectRoots(config) {
  const stateFile = path.join(config.codexHome, ".codex-global-state.json");
  const state = fs.existsSync(stateFile) ? readJson(stateFile, {}) : {};
  const configuredRoots = [
    ...(Array.isArray(state["electron-saved-workspace-roots"]) ? state["electron-saved-workspace-roots"] : []),
    ...(Array.isArray(state["active-workspace-roots"]) ? state["active-workspace-roots"] : []),
  ];
  const roots = [];
  const add = (candidate, origin) => {
    if (!candidate) return;
    const localAbsolute = process.platform === "win32"
      ? path.win32.isAbsolute(stripWindowsExtendedPrefix(candidate))
      : path.posix.isAbsolute(String(candidate));
    if (!localAbsolute) return;
    let resolved;
    try { resolved = expandPath(String(candidate)); } catch { return; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    if (roots.some((item) => normalizedPath(item.path) === normalizedPath(resolved))) return;
    if (origin === "thread-cwd" && roots.some((item) => pathContains(item.path, resolved))) return;
    roots.push({ path: resolved, label: path.basename(resolved), origin });
  };
  for (const root of configuredRoots) add(root, "codex-projects");
  for (const thread of listThreads(config.codexHome)) add(thread.cwd, "thread-cwd");
  return roots.map((root) => ({ ...root, tasks: projectThreads(config, root.path).map((thread) => ({ id: thread.id, title: thread.title ?? thread.thread_name ?? thread.id, cwd: thread.cwd })) }));
}

function registerCodexProject(projectPath, dryRun = false) {
  const resolved = path.resolve(projectPath);
  const url = `codex://new?path=${encodeURIComponent(resolved)}`;
  if (dryRun) return { registered: false, dryRun: true, url };
  let result;
  if (process.platform === "darwin") result = run("open", [url], { allowFailure: true });
  else if (process.platform === "win32") result = run("cmd.exe", ["/d", "/s", "/c", "start", "", url], { allowFailure: true });
  else return { registered: false, unsupported: true, url };
  if (result.status !== 0) throw new CodexSyncError(`Codex project registration failed: ${(result.stderr || result.stdout).trim()}`);
  return { registered: true, url };
}

function projectCatalogDir(config) {
  return path.join(config.vault, ".codex-sync", "project-catalogs");
}

function publishProjectCatalog(config, dryRun = false) {
  let syncthingDeviceId = null;
  try {
    if (config.syncthing) syncthingDeviceId = syncthingInventory(findSyncthing(config)).myID;
  } catch { /* A catalog remains useful when Syncthing is temporarily unavailable. */ }
  const discovered = codexProjectRoots(config);
  const configured = Object.values(config.projects ?? {}).map((project) => {
    const candidate = discovered.find((item) => normalizedPath(item.path) === normalizedPath(project.path));
    return { ...project, tasks: candidate?.tasks ?? projectThreads(config, project.path).map((thread) => ({ id: thread.id, title: thread.title ?? thread.thread_name ?? thread.id, cwd: thread.cwd })) };
  });
  const configuredPaths = new Set(configured.map((item) => normalizedPath(item.path)));
  const projects = [...configured, ...discovered.filter((item) => !configuredPaths.has(normalizedPath(item.path))).map((item) => ({ ...item, configured: false }))];
  const catalog = { version: FORMAT_VERSION, protocolRevision: PROTOCOL_REVISION, deviceId: config.deviceId, syncthingDeviceId, updatedAt: nowIso(), projects };
  writeJson(path.join(projectCatalogDir(config), `${config.deviceId}.json`), catalog, dryRun);
  return catalog;
}

function listProjectCatalogs(config) {
  const dir = projectCatalogDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(dir, entry.name)));
}

function addPathMap(config, from, to) {
  config.pathMaps ??= [];
  const normalizedFrom = stripWindowsExtendedPrefix(String(from)).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  config.pathMaps = config.pathMaps.filter((mapping) => stripWindowsExtendedPrefix(String(mapping.from)).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() !== normalizedFrom);
  config.pathMaps.push({ from: String(from), to: path.resolve(to) });
}

async function projectCommand(options, action, rest) {
  const { config, file } = loadConfig(options);
  config.projects ??= {};
  if (action === "discover") {
    const projects = codexProjectRoots(config).map((project) => {
      const registered = Object.values(config.projects).find((item) => normalizedPath(item.path) === normalizedPath(project.path));
      return { ...project, registered: registered ? { id: registered.id, sharePolicy: registered.sharePolicy } : null };
    });
    return { stateFile: path.join(config.codexHome, ".codex-global-state.json"), projects };
  }
  if (action === "catalogs") return { catalogs: listProjectCatalogs(config) };
  if (action === "tasks") {
    const selector = rest.join(" ") || options.path || "current";
    const projectPath = selector === "current" ? process.cwd() : expandPath(selector);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new CodexSyncError(`Project directory does not exist: ${projectPath}`);
    const selectedTasks = selectProjectThreads(config, projectPath, true);
    saveConfig(file, config, Boolean(options["dry-run"]));
    return { action: "project-tasks-selected", path: path.resolve(projectPath), selectedTasks, count: selectedTasks.length };
  }
  if (action === "map") {
    if (!options.from || !options.to) throw new CodexSyncError("project map requires --from <source-path> --to <local-path>");
    addPathMap(config, options.from, expandPath(options.to));
    saveConfig(file, config, Boolean(options["dry-run"]));
    return { action: "project-path-mapped", pathMaps: config.pathMaps };
  }
  if (action === "register") {
    const selector = rest.join(" ") || options.path || "current";
    const projectPath = selector === "current" ? process.cwd() : expandPath(selector);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new CodexSyncError(`Project directory does not exist: ${projectPath}`);
    return { action: "registered-in-codex", path: path.resolve(projectPath), ...registerCodexProject(projectPath, Boolean(options["dry-run"])) };
  }
  const executable = findSyncthing(config, options);
  config.syncthing = { ...(config.syncthing ?? {}), executable };
  const inventory = syncthingInventory(executable);
  if (action === "list") {
    saveConfig(file, config);
    return { executable, devices: inventory.devices, folders: inventory.folders.map((folder) => ({ id: folder.id, label: folder.label, path: folder.path, type: folder.type, devices: folder.devices.map((item) => item.deviceID) })) };
  }
  if (action === "add" || action === "select") {
    const selector = rest.join(" ") || options.path || "current";
    const projectPath = selector === "current" ? process.cwd() : expandPath(selector);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new CodexSyncError(`Project directory does not exist: ${projectPath}`);
    const desiredId = projectFolderId(projectPath, options.id);
    const label = options.label ?? path.basename(projectPath);
    const samePath = inventory.folders.find((folder) => normalizedPath(folder.path) === normalizedPath(projectPath));
    for (const folder of inventory.folders) {
      if (normalizedPath(folder.path) === normalizedPath(projectPath)) continue;
      if (pathContains(folder.path, projectPath) || pathContains(projectPath, folder.path)) {
        throw new CodexSyncError(`Syncthing folder paths must stay independent: '${projectPath}' overlaps '${folder.path}' (${folder.id}).`);
      }
    }
    let folder = samePath;
    let created = false;
    if (!folder) {
      if (inventory.folders.some((item) => item.id === desiredId)) throw new CodexSyncError(`Syncthing folder ID already exists for another path: ${desiredId}`);
      if (!options["dry-run"]) stCli(executable, ["config", "folders", "add", "--id", desiredId, "--label", label, "--path", path.resolve(projectPath), "--type", "sendreceive"]);
      folder = { id: desiredId, label, path: path.resolve(projectPath), type: "sendreceive", devices: [{ deviceID: inventory.myID }] };
      created = true;
    }
    const shareSelectors = options["share-with"] ?? [];
    const devices = selectSyncthingDevices(inventory, shareSelectors);
    const normalizedSelectors = shareSelectors.flatMap((item) => String(item).split(",")).map((item) => item.trim().toLowerCase()).filter(Boolean);
    const sharePolicy = !normalizedSelectors.length || normalizedSelectors.includes("all") ? "all" : normalizedSelectors.includes("none") ? "none" : "selected";
    const existingDevices = new Set((folder.devices ?? []).map((item) => item.deviceID));
    const addedDevices = [];
    for (const device of devices) {
      if (existingDevices.has(device.id)) continue;
      if (!options["dry-run"]) stCli(executable, ["config", "folders", folder.id, "devices", "add", "--device-id", device.id]);
      addedDevices.push(device);
    }
    const ignorePatterns = options.ignore ?? config.projects[folder.id]?.ignorePatterns ?? [];
    if (options.ignore?.length && !options["dry-run"]) {
      await syncthingRest(config, `/db/ignores?folder=${encodeURIComponent(folder.id)}`, { method: "POST", body: { ignore: ignorePatterns } });
    }
    const selectedTasks = options["no-tasks"] ? [] : selectProjectThreads(config, projectPath, true);
    config.projects[folder.id] = { id: folder.id, label: folder.label ?? label, path: path.resolve(projectPath), devices: [...new Set([...existingDevices, ...devices.map((item) => item.id)])], sharePolicy, ignorePatterns, selectedTaskIds: selectedTasks.map((item) => item.id), addedAt: config.projects[folder.id]?.addedAt ?? nowIso(), updatedAt: nowIso() };
    saveConfig(file, config, Boolean(options["dry-run"]));
    return { action: created ? "created" : "already-configured", dryRun: Boolean(options["dry-run"]), folder: config.projects[folder.id], selectedTasks, sharedWith: devices, newlySharedWith: addedDevices };
  }
  if (action === "accept") {
    const id = rest[0] || options.id;
    const localPath = expandPath(options.path ?? rest.slice(1).join(" "));
    if (!id || !localPath) throw new CodexSyncError("project accept requires <folder-id> --path <local-path>");
    const catalogs = listProjectCatalogs(config);
    const sources = catalogs.flatMap((catalog) => (catalog.projects ?? []).filter((project) => project.id === id).map((project) => ({ catalog, project })));
    if (!sources.length) throw new CodexSyncError(`No portable project catalog advertises folder ID: ${id}`);
    const source = sources.sort((a, b) => String(b.catalog.updatedAt).localeCompare(String(a.catalog.updatedAt)))[0];
    mkdir(localPath, Boolean(options["dry-run"]));
    let folder = inventory.folders.find((item) => item.id === id);
    if (folder && normalizedPath(folder.path) !== normalizedPath(localPath)) throw new CodexSyncError(`Syncthing folder ${id} already uses another path: ${folder.path}`);
    if (!folder) {
      if (!options["dry-run"]) stCli(executable, ["config", "folders", "add", "--id", id, "--label", source.project.label ?? id, "--path", path.resolve(localPath), "--type", "sendreceive"]);
      folder = { id, label: source.project.label ?? id, path: path.resolve(localPath), type: "sendreceive", devices: [{ deviceID: inventory.myID }] };
    }
    const existingDevices = new Set((folder.devices ?? []).map((item) => item.deviceID));
    for (const item of sources) {
      const remoteId = item.catalog.syncthingDeviceId;
      if (!remoteId || remoteId === inventory.myID || existingDevices.has(remoteId)) continue;
      if (!inventory.devices.some((device) => device.id === remoteId)) continue;
      if (!options["dry-run"]) stCli(executable, ["config", "folders", id, "devices", "add", "--device-id", remoteId]);
      existingDevices.add(remoteId);
    }
    for (const item of sources) addPathMap(config, item.project.path, localPath);
    config.projects[id] = { id, label: source.project.label ?? id, path: path.resolve(localPath), devices: [...existingDevices], sharePolicy: "selected", ignorePatterns: source.project.ignorePatterns ?? [], sourceDevices: sources.map((item) => item.catalog.deviceId), addedAt: config.projects[id]?.addedAt ?? nowIso(), updatedAt: nowIso() };
    const registration = options["no-register"] ? { registered: false, skipped: true } : registerCodexProject(localPath, Boolean(options["dry-run"]));
    saveConfig(file, config, Boolean(options["dry-run"]));
    return { action: "accepted", dryRun: Boolean(options["dry-run"]), folder: config.projects[id], pathMaps: config.pathMaps, registration };
  }
  const selector = rest.join(" ") || options.id || options.path;
  if (action === "remove") {
    if (!selector) throw new CodexSyncError("project remove requires a folder ID or path");
    const configured = Object.values(config.projects).find((item) => item.id === selector || normalizedPath(item.path) === normalizedPath(selector) || item.label === selector);
    const registered = inventory.folders.find((item) => item.id === selector || normalizedPath(item.path) === normalizedPath(selector) || item.label === selector);
    const id = registered?.id ?? configured?.id;
    if (!id) throw new CodexSyncError(`Project is not registered: ${selector}`);
    if (registered && !options["dry-run"]) stCli(executable, ["config", "folders", id, "delete"]);
    if (!options["dry-run"]) delete config.projects[id];
    saveConfig(file, config, Boolean(options["dry-run"]));
    return { action: "removed-registration", dryRun: Boolean(options["dry-run"]), folderId: id, path: registered?.path ?? configured?.path, localFilesPreserved: true };
  }
  const folder = resolveProjectFolder(inventory, selector);
  if (action === "status") {
    const local = await syncthingRest(config, `/db/status?folder=${encodeURIComponent(folder.id)}`);
    const remote = [];
    for (const device of inventory.devices.filter((item) => !item.self && folder.devices.some((entry) => entry.deviceID === item.id))) {
      try {
        const completion = await syncthingRest(config, `/db/completion?folder=${encodeURIComponent(folder.id)}&device=${encodeURIComponent(device.id)}`);
        remote.push({ ...device, completion: completion.completion, needItems: completion.needItems, needBytes: completion.needBytes });
      } catch (error) { remote.push({ ...device, error: error.message }); }
    }
    saveConfig(file, config);
    return { folder: { id: folder.id, label: folder.label, path: folder.path }, local: { state: local.state, errors: local.errors, needFiles: local.needFiles, needBytes: local.needBytes }, remote };
  }
  if (action === "rescan") {
    await syncthingRest(config, `/db/scan?folder=${encodeURIComponent(folder.id)}`, { method: "POST" });
    saveConfig(file, config);
    return { action: "rescan-requested", folder: folder.id };
  }
  throw new CodexSyncError(`Unknown project action: ${action}`);
}

function syncthingCommand(options, action) {
  const { config, file } = loadConfig(options);
  if (action === "configure") {
    const executable = findSyncthing(config, options);
    config.syncthing = { ...(config.syncthing ?? {}), executable, configFile: options["config-file"] ? expandPath(options["config-file"]) : config.syncthing?.configFile };
    saveConfig(file, config);
    return { action: "configured", ...config.syncthing };
  }
  const executable = findSyncthing(config, options);
  const inventory = syncthingInventory(executable);
  if (action === "add-device") {
    const id = options["device-id"];
    if (!id) throw new CodexSyncError("syncthing add-device requires --device-id <ID>");
    const existing = inventory.devices.find((device) => device.id === id);
    if (!existing) stCli(executable, ["config", "devices", "add", "--device-id", id, "--name", options.name ?? id.slice(0, 7)]);
    config.syncthing = { ...(config.syncthing ?? {}), executable };
    saveConfig(file, config);
    return { action: existing ? "already-paired" : "device-added", device: existing ?? { id, name: options.name ?? id.slice(0, 7), self: false }, note: "The peer device must also add/accept this device. The next sync run auto-shares projects whose sharePolicy is all." };
  }
  return { executable, myID: inventory.myID, devices: inventory.devices, folders: inventory.folders.map((folder) => ({ id: folder.id, label: folder.label, path: folder.path, devices: folder.devices.map((item) => item.deviceID) })) };
}

function gitHasUpstream(vault) {
  return run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: vault, allowFailure: true }).status === 0;
}

function gitPre(config, dryRun) {
  if (config.transport !== "git" || dryRun) return;
  if (!fs.existsSync(path.join(config.vault, ".git"))) throw new CodexSyncError(`Git transport requires a repository: ${config.vault}`);
  if (gitHasUpstream(config.vault)) run("git", ["pull", "--rebase", "--autostash"], { cwd: config.vault });
}

function gitPost(config, dryRun) {
  if (config.transport !== "git" || dryRun) return;
  run("git", ["add", "--", ".codex-sync", "conversations", "skills", "conflicts"], { cwd: config.vault });
  const changed = run("git", ["diff", "--cached", "--quiet"], { cwd: config.vault, allowFailure: true }).status !== 0;
  if (!changed) return;
  run("git", ["commit", "-m", `codex-sync: ${config.deviceId} ${nowIso()}`], { cwd: config.vault });
  if (gitHasUpstream(config.vault)) run("git", ["push"], { cwd: config.vault });
}

function ensureVault(config, dryRun = false) {
  mkdir(config.vault, dryRun);
  for (const relative of [".codex-sync/selections", ".codex-sync/project-catalogs", "conversations", "skills", "conflicts/skills"]) mkdir(path.join(config.vault, relative), dryRun);
  const marker = path.join(config.vault, ".codex-sync", "vault.json");
  const existing = fs.existsSync(marker) ? readJson(marker) : null;
  if (existing && existing.version !== FORMAT_VERSION) throw new CodexSyncError(`Vault protocol version ${existing.version} is unsupported.`);
  if (!existing) writeJson(marker, { version: FORMAT_VERSION, protocolRevision: PROTOCOL_REVISION, createdAt: nowIso(), format: "codex-sync-portable-v1" }, dryRun);
  else if (Number(existing.protocolRevision ?? 1) < PROTOCOL_REVISION) writeJson(marker, { ...existing, protocolRevision: PROTOCOL_REVISION, upgradedAt: nowIso() }, dryRun);
}

function withVaultLock(config, dryRun, callback) {
  if (dryRun) return callback();
  const lock = path.join(path.dirname(config._configFile ?? path.join(CONFIG_ROOT, "config.json")), "operation.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
    fs.writeFileSync(fd, JSON.stringify({ device: config.deviceId, pid: process.pid, at: nowIso() }));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 10 * 60 * 1000) throw new CodexSyncError(`Vault is locked by another Codex Sync run: ${lock}`);
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, "wx");
  }
  try { return callback(); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function initCommand(options) {
  const file = configPath(options);
  if (fs.existsSync(file) && !options.force) throw new CodexSyncError(`Config already exists: ${file} (use --force to replace)`);
  const codexHome = detectCodexHome(options);
  let vault = expandPath(options.vault);
  if (!vault) throw new CodexSyncError("init requires --vault <path>");
  const transport = options.transport ?? "folder";
  if (!['folder', 'git'].includes(transport)) throw new CodexSyncError("--transport must be folder or git");
  if (transport === "git" && options.repo && !fs.existsSync(path.join(vault, ".git"))) {
    mkdir(path.dirname(vault));
    run("git", ["clone", options.repo, vault]);
  }
  const config = {
    version: FORMAT_VERSION,
    deviceId: deviceId(options.device),
    vault,
    transport,
    codexHome,
    conversations: {},
    skillSources: commonSkillRoots(codexHome),
    projects: {},
    syncthing: null,
    pathMaps: [],
    autoSyncMinutes: Number(options.minutes ?? 5),
    createdAt: nowIso(),
  };
  Object.defineProperty(config, "_configFile", { value: file, enumerable: false, writable: true });
  ensureVault(config);
  saveConfig(file, config);
  return { action: "init", config: file, vault, deviceId: config.deviceId, transport, skillSources: config.skillSources };
}

function publishSelections(config, dryRun = false) {
  const file = path.join(config.vault, ".codex-sync", "selections", `${config.deviceId}.json`);
  const eventTimes = Object.values(config.conversations ?? {}).map((event) => event.updatedAt).filter(Boolean).sort();
  writeJson(file, { version: FORMAT_VERSION, deviceId: config.deviceId, updatedAt: eventTimes.at(-1) ?? config.createdAt, conversations: config.conversations }, dryRun);
}

function mergeSelections(config) {
  const dir = path.join(config.vault, ".codex-sync", "selections");
  const merged = { ...config.conversations };
  if (!fs.existsSync(dir)) return merged;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const data = readJson(path.join(dir, entry.name), { conversations: {} });
    for (const [id, event] of Object.entries(data.conversations ?? {})) {
      const current = merged[id];
      if (!current || String(event.updatedAt) > String(current.updatedAt)
        || (event.updatedAt === current.updatedAt && String(data.deviceId) > String(current.deviceId ?? ""))) {
        merged[id] = { ...event, deviceId: data.deviceId };
      }
    }
  }
  return merged;
}

function conversationMetadata(config, id, rollout, snapshot) {
  const row = threadRow(config.codexHome, id);
  const first = firstEventMetadata(snapshot);
  const relative = portableRelative(config.codexHome, rollout);
  if (!relative.startsWith("sessions/")) throw new CodexSyncError(`Rollout is outside Codex sessions: ${rollout}`);
  return {
    version: FORMAT_VERSION,
    id,
    title: row?.title ?? config.conversations[id]?.title ?? id,
    createdAt: row?.created_at ? new Date(Number(row.created_at) * 1000).toISOString() : first.timestamp,
    updatedAt: row?.updated_at ? new Date(Number(row.updated_at) * 1000).toISOString() : nowIso(),
    relativePath: relative,
    cwd: normalizeFsPath(row?.cwd ?? first.cwd ?? os.homedir()),
    cliVersion: row?.cli_version ?? first.cli_version,
    modelProvider: row?.model_provider ?? first.model_provider,
    row,
    exportedBy: config.deviceId,
  };
}

function portableConversationMetadata(metadata) {
  return {
    version: FORMAT_VERSION,
    id: metadata.id,
    title: metadata.title,
    createdAt: metadata.createdAt,
    relativePath: metadata.relativePath,
    cwd: normalizeFsPath(metadata.cwd ?? os.homedir()),
    cliVersion: metadata.cliVersion,
    modelProvider: metadata.modelProvider,
  };
}

function readConversationMetadata(root) {
  const coreFile = path.join(root, "metadata.json");
  if (!fs.existsSync(coreFile)) throw new CodexSyncError(`Conversation metadata missing: ${root}`);
  const core = readJson(coreFile);
  const deviceDir = path.join(root, "metadata");
  if (!fs.existsSync(deviceDir)) return core;
  const deviceMetadata = fs.readdirSync(deviceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(deviceDir, entry.name)))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
  return deviceMetadata ? {
    ...core,
    ...deviceMetadata,
    id: core.id,
    createdAt: core.createdAt,
    relativePath: core.relativePath,
    cwd: core.cwd,
    row: deviceMetadata.row,
  } : core;
}

function vaultConversationHealth(config, id) {
  const root = path.join(config.vault, "conversations", id);
  const headsDir = path.join(root, "heads");
  const heads = [];
  if (fs.existsSync(headsDir)) {
    for (const entry of fs.readdirSync(headsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const device = entry.name.slice(0, -6);
      try {
        const audit = auditJsonlFile(path.join(headsDir, entry.name));
        heads.push({ device, stable: audit.stable, semanticOk: audit.semanticOk, danglingCalls: audit.danglingCalls.length, openTurns: audit.openTurns.length, sha256: audit.sha256 });
      } catch (error) {
        heads.push({ device, stable: false, semanticOk: false, error: error.message });
      }
    }
  }
  let canonical = null;
  const canonicalFile = path.join(root, "canonical.jsonl");
  if (fs.existsSync(canonicalFile)) {
    try {
      const audit = auditJsonlFile(canonicalFile);
      canonical = { stable: audit.stable, semanticOk: audit.semanticOk, danglingCalls: audit.danglingCalls.length, openTurns: audit.openTurns.length, sha256: audit.sha256 };
    } catch (error) {
      canonical = { stable: false, semanticOk: false, error: error.message };
    }
  }
  const unsafeHeads = heads.filter((item) => !item.stable).map((item) => item.device);
  return { ok: Boolean(canonical?.stable) && unsafeHeads.length === 0, canonical, heads, unsafeHeads };
}

function reconcileConversation(config, id, dryRun, summary) {
  const root = path.join(config.vault, "conversations", id);
  const headsDir = path.join(root, "heads");
  if (!fs.existsSync(headsDir)) return null;
  const heads = fs.readdirSync(headsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const file = path.join(headsDir, entry.name);
      const data = completeJsonlSnapshot(file);
      return { device: entry.name.slice(0, -6), file, data, audit: auditJsonlBuffer(data) };
    });
  if (!heads.length) return null;
  const validHeads = heads.filter((item) => item.audit.stable);
  for (const invalid of heads.filter((item) => !item.audit.stable)) {
    summary.conversationsSkipped += 1;
    summary.warnings.push(`Ignored unsafe head ${id}/${invalid.device}: danglingCalls=${invalid.audit.danglingCalls.length}, openTurns=${invalid.audit.openTurns.length}.`);
  }
  if (!validHeads.length) {
    const canonicalFile = path.join(root, "canonical.jsonl");
    if (!fs.existsSync(canonicalFile)) return null;
    const canonical = completeJsonlSnapshot(canonicalFile);
    const audit = auditJsonlBuffer(canonical);
    if (!audit.stable) {
      summary.warnings.push(`Canonical ${id} is semantically incomplete and was quarantined from import.`);
      return null;
    }
    return canonical;
  }
  let compatible = true;
  for (let i = 0; i < validHeads.length; i += 1) {
    for (let j = i + 1; j < validHeads.length; j += 1) {
      if (!isPrefix(validHeads[i].data, validHeads[j].data) && !isPrefix(validHeads[j].data, validHeads[i].data)) compatible = false;
    }
  }
  const conflictFile = path.join(root, "conflict.json");
  if (!compatible) {
    writeJson(conflictFile, {
      version: FORMAT_VERSION,
      threadId: id,
      detectedAt: nowIso(),
      heads: validHeads.map((item) => ({ device: item.device, bytes: item.data.length, sha256: hashBuffer(item.data) })),
      instruction: "Choose one device head with conversation resolve; no automatic merge was performed.",
    }, dryRun);
    summary.conversationConflicts += 1;
    summary.warnings.push(`Conversation ${id} diverged; all device heads were preserved.`);
    if (!fs.existsSync(path.join(root, "canonical.jsonl"))) return null;
    const canonical = completeJsonlSnapshot(path.join(root, "canonical.jsonl"));
    return auditJsonlBuffer(canonical).stable ? canonical : null;
  }
  const longest = [...validHeads].sort((a, b) => b.data.length - a.data.length || a.device.localeCompare(b.device))[0];
  atomicWrite(path.join(root, "canonical.jsonl"), longest.data, dryRun);
  if (!dryRun && fs.existsSync(conflictFile)) fs.unlinkSync(conflictFile);
  return longest.data;
}

function exportConversation(config, id, dryRun, summary) {
  const rollout = findRollout(config.codexHome, id);
  if (!rollout) return false;
  const stable = stableConversationSnapshot(rollout);
  const snapshot = stable.snapshot;
  const audit = stable.audit;
  if (!snapshot) {
    summary.conversationsSkipped += 1;
    summary.warnings.push(`Skipped active or incomplete local conversation ${id}: danglingCalls=${audit.danglingCalls.length}, openTurns=${audit.openTurns.length}.`);
    return false;
  }
  const root = path.join(config.vault, "conversations", id);
  const metadata = conversationMetadata(config, id, rollout, snapshot);
  if (config.conversations?.[id]) config.conversations[id].title = metadata.title;
  mkdir(path.join(root, "heads"), dryRun);
  atomicWrite(path.join(root, "heads", `${config.deviceId}.jsonl`), snapshot, dryRun);
  const coreFile = path.join(root, "metadata.json");
  if (!fs.existsSync(coreFile)) writeJson(coreFile, portableConversationMetadata(metadata), dryRun);
  writeJson(path.join(root, "metadata", `${config.deviceId}.json`), metadata, dryRun);
  summary.conversationsPushed += 1;
  if (stable.checkpoint) summary.conversationCheckpoints += 1;
  return true;
}

function importConversation(config, id, canonical, dryRun, summary) {
  if (!canonical) return false;
  const canonicalAudit = auditJsonlBuffer(canonical);
  if (!canonicalAudit.stable) {
    summary.conversationsSkipped += 1;
    summary.warnings.push(`Refused semantically incomplete canonical conversation ${id}.`);
    return false;
  }
  const root = path.join(config.vault, "conversations", id);
  const metadata = readConversationMetadata(root);
  metadata.pathMaps = config.pathMaps;
  const relative = metadata.relativePath;
  if (!String(relative).startsWith("sessions/")) throw new CodexSyncError(`Unsafe conversation relative path: ${relative}`);
  const destination = safeJoin(config.codexHome, relative);
  const local = fs.existsSync(destination) ? completeJsonlSnapshot(destination) : null;
  if (local && !isPrefix(local, canonical) && !isPrefix(canonical, local)) {
    summary.conversationConflicts += 1;
    summary.warnings.push(`Local conversation ${id} diverges from canonical; local file was not overwritten.`);
    return false;
  }
  if (!local || isPrefix(local, canonical)) {
    atomicWrite(destination, canonical, dryRun);
    ensureThreadIndex(config.codexHome, metadata, destination, dryRun);
    summary.conversationsPulled += 1;
  } else if (isPrefix(canonical, local)) {
    ensureThreadIndex(config.codexHome, metadata, destination, dryRun);
  }
  return true;
}

function syncConversations(config, direction, dryRun, summary) {
  publishSelections(config, dryRun);
  config.conversations = mergeSelections(config);
  const ids = Object.entries(config.conversations).filter(([, event]) => event.selected).map(([id]) => id);
  for (const id of ids) {
    try {
      if (direction !== "pull") exportConversation(config, id, dryRun, summary);
      const canonical = reconcileConversation(config, id, dryRun, summary);
      if (direction !== "push") importConversation(config, id, canonical, dryRun, summary);
    } catch (error) {
      summary.conversationErrors += 1;
      summary.warnings.push(`Conversation ${id} failed safely without blocking other collections: ${error.message}`);
    }
  }
}

function skillStateFile(config, collection) {
  return path.join(path.dirname(config._configFile ?? path.join(CONFIG_ROOT, "config.json")), "state", `${config.deviceId}-${collection}.json`);
}

function conflictStamp() {
  return nowIso().replace(/[-:.TZ]/g, "");
}

function syncSkillSource(config, source, direction, dryRun, summary) {
  const collection = slug(source.name);
  const localRoot = expandPath(source.path);
  const remoteRoot = path.join(config.vault, "skills", collection);
  mkdir(localRoot, dryRun);
  mkdir(remoteRoot, dryRun);
  const stateFile = skillStateFile(config, collection);
  const state = readJson(stateFile, { version: FORMAT_VERSION, files: {} });
  const local = walkFiles(localRoot, source.excludes ?? []);
  const remote = walkFiles(remoteRoot, []);
  assertPortableCaseUnique(local, `local skill collection ${collection}`);
  assertPortableCaseUnique(remote, `vault skill collection ${collection}`);
  const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.files ?? {})]);
  const next = { version: FORMAT_VERSION, collection, updatedAt: nowIso(), files: { ...state.files } };
  for (const relative of [...paths].sort()) {
    const l = local.get(relative);
    const r = remote.get(relative);
    const base = state.files?.[relative];
    if (l?.hash === r?.hash) {
      if (l) next.files[relative] = l.hash;
      continue;
    }
    let action = null;
    if (direction === "push") {
      if (l && (!r || r.hash === base)) action = "push";
      else if (!l && r) action = "keep-remote";
      else action = "conflict";
    } else if (direction === "pull") {
      if (r && (!l || l.hash === base)) action = "pull";
      else if (!r && l) action = "keep-local";
      else action = "conflict";
    } else if (l && !r) action = "push";
    else if (r && !l) action = "pull";
    else if (l && r && base && l.hash === base) action = "pull";
    else if (l && r && base && r.hash === base) action = "push";
    else action = "conflict";

    if (action === "push") {
      copyAtomic(l.file, safeJoin(remoteRoot, relative), dryRun);
      next.files[relative] = l.hash;
      summary.skillFilesPushed += 1;
    } else if (action === "pull") {
      copyAtomic(r.file, safeJoin(localRoot, relative), dryRun);
      next.files[relative] = r.hash;
      summary.skillFilesPulled += 1;
    } else if (action === "keep-local") next.files[relative] = l.hash;
    else if (action === "keep-remote") next.files[relative] = r.hash;
    else {
      const stamp = conflictStamp();
      const conflictRoot = path.join(config.vault, "conflicts", "skills", collection, `${relative}.${stamp}`);
      if (l) copyAtomic(l.file, `${conflictRoot}.${config.deviceId}.local`, dryRun);
      if (r) {
        copyAtomic(r.file, `${conflictRoot}.vault`, dryRun);
        copyAtomic(r.file, `${safeJoin(localRoot, relative)}.codex-sync-conflict-${config.deviceId}-${stamp}`, dryRun);
      }
      summary.skillConflicts += 1;
      summary.warnings.push(`Skill conflict in ${collection}/${relative}; originals were preserved.`);
    }
  }
  writeJson(stateFile, next, dryRun);
}

function syncSkills(config, direction, dryRun, summary) {
  for (const source of config.skillSources) syncSkillSource(config, source, direction, dryRun, summary);
}

function newSummary(direction, dryRun) {
  return {
    direction,
    dryRun,
    conversationsPushed: 0,
    conversationsPulled: 0,
    conversationCheckpoints: 0,
    conversationsSkipped: 0,
    conversationErrors: 0,
    conversationConflicts: 0,
    skillFilesPushed: 0,
    skillFilesPulled: 0,
    skillConflicts: 0,
    projectSharesAdded: 0,
    warnings: [],
  };
}

function reconcileProjectShares(config, dryRun, summary) {
  if (!config.syncthing || !Object.keys(config.projects ?? {}).length) return;
  try {
    const executable = findSyncthing(config);
    const inventory = syncthingInventory(executable);
    const remotes = inventory.devices.filter((device) => !device.self);
    for (const project of Object.values(config.projects)) {
      if (project.sharePolicy !== "all") continue;
      const folder = inventory.folders.find((item) => item.id === project.id);
      if (!folder) {
        summary.warnings.push(`Syncthing project registration is missing: ${project.id}`);
        continue;
      }
      const existing = new Set(folder.devices.map((item) => item.deviceID));
      for (const device of remotes) {
        if (existing.has(device.id)) continue;
        if (!dryRun) stCli(executable, ["config", "folders", folder.id, "devices", "add", "--device-id", device.id]);
        existing.add(device.id);
        summary.projectSharesAdded += 1;
      }
      project.devices = [...existing];
      project.updatedAt = nowIso();
    }
  } catch (error) {
    summary.warnings.push(`Syncthing project share reconciliation skipped: ${error.message}`);
  }
}

function buildDeviceReport(config, lastRunOverride = undefined) {
  const selectedConversations = Object.entries(config.conversations ?? {}).filter(([, event]) => event.selected).map(([id, event]) => {
    const rollout = findRollout(config.codexHome, id);
    let audit = null;
    try { if (rollout) audit = auditJsonlFile(rollout); } catch (error) { audit = { semanticOk: false, error: error.message }; }
    return {
      id,
      title: event.title,
      rolloutExists: Boolean(rollout),
      indexedInStateDb: Boolean(threadRow(config.codexHome, id)),
      semanticOk: Boolean(audit?.semanticOk),
      stable: Boolean(audit?.stable),
      persistentDanglingCalls: audit?.persistentDanglingCalls?.length ?? null,
      staleOpenTurns: audit?.staleOpenTurns?.length ?? null,
      vaultHealth: vaultConversationHealth(config, id),
    };
  });
  const skillSources = config.skillSources.map((source) => {
    const files = walkFiles(source.path, source.excludes ?? []);
    const skillDirectories = fs.existsSync(source.path)
      ? fs.readdirSync(source.path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !(source.excludes ?? []).includes(entry.name)).length
      : 0;
    return { name: source.name, path: source.path, exists: fs.existsSync(source.path), skillDirectories, files: files.size };
  });
  return {
    version: FORMAT_VERSION,
    protocolRevision: PROTOCOL_REVISION,
    scriptSha256: hashFile(SCRIPT_PATH),
    deviceId: config.deviceId,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    codexHome: config.codexHome,
    vault: config.vault,
    selectedConversations,
    skillSources,
    projects: Object.values(config.projects ?? {}).map((project) => ({ id: project.id, label: project.label, path: project.path, selectedTaskIds: project.selectedTaskIds ?? [] })),
    daemon: daemonStatus(config, config._configFile),
    maintenance: { enabled: fs.existsSync(maintenanceFile(config)) },
    lastRun: lastRunOverride === undefined ? readJson(lastRunFile(config), null) : lastRunOverride,
  };
}

function publishDeviceReport(config, dryRun = false, lastRunOverride = undefined) {
  const report = buildDeviceReport(config, lastRunOverride);
  writeJson(path.join(config.vault, ".codex-sync", "device-reports", `${config.deviceId}.json`), report, dryRun);
  return report;
}

function listDeviceReports(config) {
  const dir = path.join(config.vault, ".codex-sync", "device-reports");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(dir, entry.name)));
}

function maintenanceFile(config) {
  return path.join(config.vault, ".codex-sync", "maintenance.json");
}

function lastRunFile(config) {
  return path.join(path.dirname(config._configFile ?? path.join(CONFIG_ROOT, "config.json")), "runs", `${config.deviceId}-last.json`);
}

function recordLastRun(config, value, dryRun = false) {
  if (!dryRun) writeJson(lastRunFile(config), value, false);
}

function maintenanceCommand(options, action) {
  const { config } = loadConfig(options);
  const file = maintenanceFile(config);
  if (action === "status") return { enabled: fs.existsSync(file), file, detail: fs.existsSync(file) ? readJson(file) : null };
  if (action === "on") {
    const detail = { enabled: true, deviceId: config.deviceId, at: nowIso(), reason: options.reason ?? "maintenance" };
    writeJson(file, detail);
    return { action: "maintenance-enabled", file, detail };
  }
  if (action === "off") {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { action: "maintenance-disabled", file };
  }
  throw new CodexSyncError(`Unknown maintenance action: ${action}`);
}

function syncCommand(options, direction = "sync") {
  const { config, file } = loadConfig(options);
  const dryRun = Boolean(options["dry-run"]);
  const summary = newSummary(direction, dryRun);
  const startedAt = nowIso();
  let reportPublished = false;
  try {
    ensureVault(config, dryRun);
    if (!dryRun && fs.existsSync(maintenanceFile(config)) && !options.force) {
      throw new CodexSyncError(`Vault maintenance mode is enabled: ${maintenanceFile(config)} (use --force only for a controlled repair run)`);
    }
    gitPre(config, dryRun);
    withVaultLock(config, dryRun, () => {
      syncConversations(config, direction, dryRun, summary);
      syncSkills(config, direction, dryRun, summary);
      publishProjectCatalog(config, dryRun);
      reconcileProjectShares(config, dryRun, summary);
      const successfulRun = { ok: true, startedAt, finishedAt: nowIso(), summary };
      recordLastRun(config, successfulRun, dryRun);
      publishDeviceReport(config, dryRun, successfulRun);
      reportPublished = !dryRun;
      saveConfig(file, config, dryRun);
    });
    gitPost(config, dryRun);
    return summary;
  } catch (error) {
    const failedRun = { ok: false, startedAt, finishedAt: nowIso(), error: error.message, direction };
    recordLastRun(config, failedRun, dryRun);
    if (reportPublished) {
      try { withVaultLock(config, false, () => publishDeviceReport(config, false, failedRun)); }
      catch { /* Preserve the original sync failure. The next successful run republishes health. */ }
    }
    throw error;
  }
}

function selectConversation(options, selector, selected) {
  const { config, file } = loadConfig(options);
  let row;
  if (selected) row = resolveThread(config, selector);
  else {
    const exact = Object.keys(config.conversations).find((id) => id === selector);
    if (exact) row = { id: exact, title: config.conversations[exact]?.title };
    else row = resolveThread(config, selector);
  }
  config.conversations[row.id] = {
    selected,
    updatedAt: nowIso(),
    title: row.title ?? row.thread_name ?? row.id,
    deviceId: config.deviceId,
  };
  saveConfig(file, config);
  return { action: selected ? "selected" : "unselected", id: row.id, title: config.conversations[row.id].title };
}

function sessionIndexEntry(codexHome, id) {
  const file = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).find((item) => item.id === id) ?? null;
}

function localCatalogEntry(codexHome, id) {
  const db = openDatabase(path.join(codexHome, "sqlite", "codex-dev.db"), true);
  if (!db) return null;
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_thread_catalog'").get();
    return table ? db.prepare("SELECT * FROM local_thread_catalog WHERE thread_id=? ORDER BY host_id='local' DESC LIMIT 1").get(id) ?? null : null;
  } finally { db.close(); }
}

function conversationAudit(config, selector) {
  const row = resolveThread(config, selector);
  const rollout = findRollout(config.codexHome, row.id);
  if (!rollout) throw new CodexSyncError(`Rollout not found for ${row.id}`);
  const audit = auditJsonlFile(rollout);
  const state = threadRow(config.codexHome, row.id);
  const index = sessionIndexEntry(config.codexHome, row.id);
  const catalog = localCatalogEntry(config.codexHome, row.id);
  const expectedTitle = config.conversations?.[row.id]?.title ?? catalog?.display_title ?? state?.title ?? row.id;
  const titleMatches = [state?.title, index?.thread_name, catalog?.display_title].filter((value) => value !== undefined && value !== null)
    .every((value) => String(value) === String(expectedTitle));
  return {
    id: row.id,
    expectedTitle,
    rollout: audit,
    indexes: {
      state: state ? { title: state.title, rolloutPath: state.rollout_path, updatedAt: state.updated_at, hasUserEvent: state.has_user_event } : null,
      sessionIndex: index,
      localCatalog: catalog ? { title: catalog.display_title, updatedAt: catalog.source_updated_at, hostId: catalog.host_id } : null,
      consistent: Boolean(state && index && titleMatches),
    },
  };
}

function auditConversationCommand(options, selector) {
  const { config } = loadConfig(options);
  return conversationAudit(config, selector);
}

function repairConversationCommand(options, selector) {
  const { config, file } = loadConfig(options);
  const before = conversationAudit(config, selector);
  const rollout = before.rollout.file;
  const recovery = path.join(path.dirname(file), "recovery", `${conflictStamp()}-${before.id}`);
  mkdir(recovery);
  atomicWrite(path.join(recovery, "rollout-before-semantic-repair.jsonl"), completeJsonlSnapshot(rollout));
  const additions = [];
  for (const item of before.rollout.persistentDanglingCalls) {
    if (item.kind === "custom_tool_call") {
      additions.push({
        timestamp: nowIso(),
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: item.callId,
          output: [{ type: "input_text", text: "Codex Sync recovery: the original tool execution was interrupted before its output event was persisted. Partial side effects were inspected separately; no output is being reconstructed." }],
          internal_chat_message_metadata_passthrough: item.turnId ? { turn_id: item.turnId } : undefined,
        },
      });
    } else {
      additions.push({
        timestamp: nowIso(),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: item.callId,
          output: "Codex Sync recovery: interrupted before the original function output event was persisted.",
          internal_chat_message_metadata_passthrough: item.turnId ? { turn_id: item.turnId } : undefined,
        },
      });
    }
  }
  const turnsNeedingProjectionRepair = new Set([
    ...before.rollout.staleOpenTurns,
    ...before.rollout.projectionUnsafeAbortEvents.map((item) => item.turnId),
  ]);
  for (const turnId of turnsNeedingProjectionRepair) {
    const completedAt = Math.floor(Date.now() / 1000);
    const startedAt = before.rollout.startedTurnEvents.find((item) => item.turnId === turnId)?.startedAt;
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, (completedAt - startedAt) * 1000) : 0;
    additions.push({
      timestamp: nowIso(),
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: "<turn_aborted>\nThe previous turn was interrupted before its completion record was persisted. Codex Sync recovered the stale turn without reconstructing missing execution output.\n</turn_aborted>",
        }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    });
    additions.push({
      timestamp: nowIso(),
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: turnId,
        reason: "interrupted",
        recovery_reason: "recovered_stale_turn",
        completed_at: completedAt,
        duration_ms: durationMs,
      },
    });
  }
  if (additions.length) fs.appendFileSync(rollout, `${additions.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const state = threadRow(config.codexHome, before.id) ?? {};
  const title = String(options.title ?? config.conversations?.[before.id]?.title ?? before.indexes.localCatalog?.title ?? state.title ?? before.id).trim() || before.id;
  const metadata = {
    version: FORMAT_VERSION,
    id: before.id,
    title,
    createdAt: state.created_at ? new Date(Number(state.created_at) * 1000).toISOString() : nowIso(),
    updatedAt: state.updated_at ? new Date(Number(state.updated_at) * 1000).toISOString() : nowIso(),
    cwd: state.cwd,
    modelProvider: state.model_provider,
    cliVersion: state.cli_version,
    row: { ...state, title, rollout_path: normalizeFsPath(rollout), has_user_event: before.rollout.userMessages > 0 ? 1 : state.has_user_event },
    hasUserEvent: before.rollout.userMessages > 0 ? 1 : state.has_user_event,
    preview: state.preview || title,
  };
  ensureThreadIndex(config.codexHome, metadata, rollout, false);
  const vaultConversationRoot = path.join(config.vault, "conversations", before.id);
  if (fs.existsSync(vaultConversationRoot)) {
    metadata.relativePath = portableRelative(config.codexHome, rollout);
    writeJson(path.join(vaultConversationRoot, "metadata.json"), portableConversationMetadata(metadata));
    writeJson(path.join(vaultConversationRoot, "metadata", `${config.deviceId}.json`), { ...metadata, exportedBy: config.deviceId });
  }
  if (config.conversations?.[before.id]) config.conversations[before.id].title = title;
  saveConfig(file, config);
  const after = conversationAudit(config, before.id);
  return {
    action: additions.length ? "repaired" : "indexes-refreshed",
    id: before.id,
    recovery,
    repairedCalls: before.rollout.persistentDanglingCalls.map((item) => item.callId),
    closedStaleTurns: [...turnsNeedingProjectionRepair],
    title,
    semanticOkAfter: after.rollout.persistentDanglingCalls.filter((item) => !before.rollout.tailDanglingCalls.some((tail) => tail.callId === item.callId)).length === 0
      && after.rollout.staleOpenTurns.length === 0
      && after.rollout.projectionUnsafeAbortEvents.length === 0,
    indexesConsistent: after.indexes.consistent,
  };
}

function resolveConversationConflict(options, id) {
  const from = options["from-device"];
  if (!from) throw new CodexSyncError("conversation resolve requires --from-device <device>");
  const { config } = loadConfig(options);
  const root = path.join(config.vault, "conversations", id);
  const chosen = path.join(root, "heads", `${slug(from)}.jsonl`);
  if (!fs.existsSync(chosen)) throw new CodexSyncError(`Head not found: ${chosen}`);
  const data = completeJsonlSnapshot(chosen);
  const archive = path.join(root, "archived-heads", conflictStamp());
  mkdir(archive);
  for (const entry of fs.readdirSync(path.join(root, "heads"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name === path.basename(chosen)) continue;
    const source = path.join(root, "heads", entry.name);
    const destination = path.join(archive, entry.name);
    fs.renameSync(source, destination);
  }
  atomicWrite(path.join(root, "canonical.jsonl"), data);
  try { fs.unlinkSync(path.join(root, "conflict.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const metadata = readJson(path.join(root, "metadata.json"));
  metadata.pathMaps = config.pathMaps;
  const destination = safeJoin(config.codexHome, metadata.relativePath);
  let localBackup = null;
  if (fs.existsSync(destination)) {
    const local = completeJsonlSnapshot(destination);
    if (!local.equals(data)) {
      localBackup = path.join(path.dirname(config._configFile), "conflicts", "conversations", `${id}-${conflictStamp()}.jsonl`);
      atomicWrite(localBackup, local);
    }
  }
  atomicWrite(destination, data);
  ensureThreadIndex(config.codexHome, metadata, destination, false);
  return { action: "resolved", id, fromDevice: slug(from), archivedHeads: fs.readdirSync(archive).length, localBackup };
}

function listConversationSelections(options) {
  const { config } = loadConfig(options);
  return Object.entries(config.conversations).map(([id, event]) => ({ id, ...event }));
}

function skillsCommand(options, action, rest) {
  const { config, file } = loadConfig(options);
  if (action === "list") return config.skillSources;
  if (action === "discover") {
    const found = commonSkillRoots(config.codexHome);
    const added = [];
    for (const candidate of found) {
      if (config.skillSources.some((source) => path.resolve(source.path) === path.resolve(candidate.path))) continue;
      let name = candidate.name;
      let suffix = 2;
      while (config.skillSources.some((source) => source.name === name)) name = `${candidate.name}-${suffix++}`;
      config.skillSources.push({ ...candidate, name });
      added.push({ ...candidate, name });
    }
    saveConfig(file, config);
    return { found, added, configured: config.skillSources };
  }
  if (action === "add" || action === "install") {
    const sourcePath = expandPath(options.path ?? options.to);
    const name = slug(options.name ?? rest[0]);
    if (!sourcePath) throw new CodexSyncError(`skills ${action} requires --path/--to <directory>`);
    const existing = config.skillSources.find((source) => source.name === name);
    const item = { name, path: sourcePath, excludes: options.exclude ?? [] };
    if (existing) Object.assign(existing, item);
    else config.skillSources.push(item);
    saveConfig(file, config);
    if (action === "install" && !options["no-sync"]) return { configured: item, sync: syncCommand(options, "pull") };
    return { action: existing ? "updated" : "added", source: item };
  }
  if (action === "remove") {
    const name = slug(options.name ?? rest[0]);
    const before = config.skillSources.length;
    config.skillSources = config.skillSources.filter((source) => source.name !== name);
    if (config.skillSources.length === before) throw new CodexSyncError(`Skill collection not configured: ${name}`);
    saveConfig(file, config);
    return { action: "removed", name };
  }
  throw new CodexSyncError(`Unknown skills action: ${action}`);
}

function vaultCommand(options, action) {
  if (action !== "use") throw new CodexSyncError(`Unknown vault action: ${action}`);
  const { config, file } = loadConfig(options);
  const nextVault = expandPath(options.vault ?? options.path);
  if (!nextVault) throw new CodexSyncError("vault use requires --vault <path>");
  const transport = options.transport ?? config.transport;
  if (!["folder", "git"].includes(transport)) throw new CodexSyncError("--transport must be folder or git");
  if (transport === "git" && options.repo && !fs.existsSync(path.join(nextVault, ".git"))) {
    mkdir(path.dirname(nextVault));
    run("git", ["clone", options.repo, nextVault]);
  }
  config.vault = nextVault;
  config.transport = transport;
  ensureVault(config);
  saveConfig(file, config);
  const result = { action: "vault-updated", vault: nextVault, transport };
  if (!options["no-sync"]) result.sync = syncCommand(options, "sync");
  return result;
}

function forbiddenVaultFiles(vault) {
  if (!fs.existsSync(vault)) return [];
  const forbidden = /(^|\/)(auth\.json|config\.toml|\.system)(\/|$)|\.(sqlite|sqlite-shm|sqlite-wal)$|(^|\/)logs?(\/|$)/i;
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(portableRelative(vault, full));
    }
  };
  visit(vault);
  return files.filter((relative) => forbidden.test(relative));
}

function doctorCommand(options) {
  let config = null;
  let configFile = configPath(options);
  try { ({ config } = loadConfig(options)); } catch (error) { if (!/ENOENT|Cannot read JSON/.test(error.message)) throw error; }
  const codexHome = config?.codexHome ?? detectCodexHome(options);
  const dbFile = path.join(codexHome, "state_5.sqlite");
  const api = sqliteApi();
  const checks = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 22, version: process.versions.node, executable: process.execPath },
    config: { ok: Boolean(config), path: configFile },
    codexHome: { ok: fs.existsSync(codexHome), path: codexHome },
    sessions: { ok: fs.existsSync(path.join(codexHome, "sessions")), path: path.join(codexHome, "sessions") },
    sqlite: { ok: Boolean(api), stateDbExists: fs.existsSync(dbFile), path: dbFile },
    skillRoots: commonSkillRoots(codexHome),
  };
  if (config) {
    checks.vault = { ok: fs.existsSync(config.vault), path: config.vault, transport: config.transport };
    checks.forbiddenVaultFiles = forbiddenVaultFiles(config.vault);
    checks.selectedConversations = Object.entries(config.conversations ?? {}).filter(([, event]) => event.selected).map(([id, event]) => {
      const rollout = findRollout(codexHome, id);
      const indexed = Boolean(threadRow(codexHome, id));
      let audit = null;
      let indexesConsistent = false;
      try {
        const detail = rollout ? conversationAudit(config, id) : null;
        audit = detail?.rollout ?? null;
        indexesConsistent = Boolean(detail?.indexes?.consistent);
      } catch (error) {
        audit = { semanticOk: false, error: error.message };
      }
      return {
        id,
        title: event.title,
        rolloutExists: Boolean(rollout),
        rolloutPath: rollout,
        indexedInStateDb: indexed,
        semanticOk: Boolean(audit?.semanticOk),
        stable: Boolean(audit?.stable),
        persistentDanglingCalls: audit?.persistentDanglingCalls?.length ?? null,
        staleOpenTurns: audit?.staleOpenTurns?.length ?? null,
        openTurns: audit?.openTurns?.length ?? null,
        indexesConsistent,
        vaultHealth: vaultConversationHealth(config, id),
        error: audit?.error,
      };
    });
    try {
      const executable = findSyncthing(config, options);
      const inventory = syncthingInventory(executable);
      const vaultFolder = inventory.folders.find((item) => {
        try { return normalizedPath(item.path) === normalizedPath(config.vault); } catch { return false; }
      });
      checks.syncthing = {
        ok: true,
        executable,
        deviceCount: inventory.devices.length,
        remoteDevices: inventory.devices.filter((item) => !item.self).map((item) => ({ id: item.id, name: item.name })),
        folderCount: inventory.folders.length,
        vaultFolder: vaultFolder ? { id: vaultFolder.id, path: vaultFolder.path, paused: Boolean(vaultFolder.paused) } : null,
      };
    } catch (error) {
      checks.syncthing = { ok: false, error: error.message };
    }
  }
  const conversationsOk = !config || checks.selectedConversations.every((item) => item.rolloutExists
    && (!checks.sqlite.stateDbExists || item.indexedInStateDb)
    && item.semanticOk
    && item.indexesConsistent);
  const vaultConversationsOk = !config || fs.existsSync(maintenanceFile(config)) || checks.selectedConversations.every((item) => item.vaultHealth?.ok);
  const transportReady = !config || fs.existsSync(maintenanceFile(config)) || !checks.syncthing?.vaultFolder?.paused;
  checks.ok = checks.node.ok && checks.codexHome.ok && (!config || checks.vault.ok) && (checks.forbiddenVaultFiles?.length ?? 0) === 0 && (!config?.syncthing || checks.syncthing.ok) && conversationsOk && vaultConversationsOk && transportReady;
  return checks;
}

function statusCommand(options) {
  const { config, file } = loadConfig(options);
  const selected = Object.entries(config.conversations).filter(([, event]) => event.selected).map(([id, event]) => ({ id, title: event.title }));
  const conversationConflicts = fs.existsSync(path.join(config.vault, "conversations"))
    ? fs.readdirSync(path.join(config.vault, "conversations"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(config.vault, "conversations", entry.name, "conflict.json"))).map((entry) => entry.name)
    : [];
  const skillConflictRoot = path.join(config.vault, "conflicts", "skills");
  const vaultConversationHealthById = Object.fromEntries(selected.map((item) => [item.id, vaultConversationHealth(config, item.id)]));
  return {
    version: FORMAT_VERSION,
    config: file,
    deviceId: config.deviceId,
    transport: config.transport,
    vault: config.vault,
    selectedConversations: selected,
    skillSources: config.skillSources,
    projects: Object.values(config.projects ?? {}),
    projectCatalogs: listProjectCatalogs(config).map((catalog) => ({ deviceId: catalog.deviceId, syncthingDeviceId: catalog.syncthingDeviceId ?? null, updatedAt: catalog.updatedAt, projects: (catalog.projects ?? []).map((project) => ({ id: project.id ?? null, label: project.label, path: project.path, tasks: project.tasks?.length ?? 0, configured: project.configured !== false })) })),
    syncthing: config.syncthing,
    deviceReports: listDeviceReports(config).map((report) => ({ deviceId: report.deviceId, platform: report.platform, protocolRevision: report.protocolRevision ?? 1, scriptSha256: report.scriptSha256 ?? null, selectedConversations: report.selectedConversations.length, skillSources: report.skillSources.map((source) => ({ name: source.name, skillDirectories: source.skillDirectories, files: source.files })), daemonInstalled: report.daemon?.installed, lastRunOk: report.lastRun?.ok ?? null })),
    conversationConflicts,
    vaultConversationHealth: vaultConversationHealthById,
    skillConflictFiles: walkFiles(skillConflictRoot, []).size,
    daemon: daemonStatus(config, file),
    maintenance: { enabled: fs.existsSync(maintenanceFile(config)), file: maintenanceFile(config) },
    lastRun: readJson(lastRunFile(config), null),
  };
}

function deviceCommand(options, action) {
  const { config } = loadConfig(options);
  if (action === "report") return publishDeviceReport(config, Boolean(options["dry-run"]));
  if (action === "list") return listDeviceReports(config);
  throw new CodexSyncError(`Unknown device action: ${action}`);
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function daemonPaths(config) {
  const localRoot = path.dirname(config._configFile ?? path.join(CONFIG_ROOT, "config.json"));
  if (process.platform === "win32") return { task: "CodexSync-AutoSync", spec: path.join(localRoot, "codexsync-task.xml") };
  if (process.platform === "darwin") return { task: "com.toussaintknight.codexsync", spec: path.join(os.homedir(), "Library", "LaunchAgents", "com.toussaintknight.codexsync.plist") };
  return { task: "codexsync-autosync", spec: path.join(localRoot, "codexsync-autosync.service") };
}

function daemonStatus(config, file) {
  const target = daemonPaths(config);
  if (process.platform === "win32") {
    const result = run("schtasks.exe", ["/Query", "/TN", target.task], { allowFailure: true });
    return { installed: result.status === 0, enabled: result.status === 0 ? !/Disabled/i.test(result.stdout) : false, ...target };
  }
  if (process.platform === "darwin") {
    const loaded = run("launchctl", ["print", `gui/${process.getuid()}/${target.task}`], { allowFailure: true });
    return { installed: fs.existsSync(target.spec), enabled: loaded.status === 0, ...target };
  }
  return { installed: false, supported: false, ...target };
}

function daemonCommand(options, action) {
  const { config, file } = loadConfig(options);
  const minutes = Math.max(1, Number(options.minutes ?? config.autoSyncMinutes ?? 5));
  const target = daemonPaths(config);
  if (action === "status") return daemonStatus(config, file);
  if (action === "uninstall") {
    if (process.platform === "win32") run("schtasks.exe", ["/Delete", "/F", "/TN", target.task], { allowFailure: true });
    else if (process.platform === "darwin") {
      run("launchctl", ["unload", target.spec], { allowFailure: true });
      try { fs.unlinkSync(target.spec); } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else throw new CodexSyncError("Automatic install currently supports Windows Task Scheduler and macOS LaunchAgents.");
    return { action: "uninstalled", ...target };
  }
  if (action !== "install") throw new CodexSyncError(`Unknown daemon action: ${action}`);
  const dryRun = Boolean(options["dry-run"]);
  if (process.platform === "win32") {
    const start = new Date(Date.now() + 60_000).toTimeString().slice(0, 5);
    const xml = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Sync selected Codex conversations and personal skills.</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>${new Date().toISOString().slice(0, 10)}T${start}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></CalendarTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xmlEscape(process.execPath)}</Command><Arguments>${xmlEscape(`--no-warnings "${SCRIPT_PATH}" sync --config "${file}" --quiet`)}</Arguments></Exec></Actions></Task>`;
    atomicWrite(target.spec, Buffer.from(`\ufeff${xml}`, "utf16le"), dryRun);
    if (!dryRun) run("schtasks.exe", ["/Create", "/F", "/TN", target.task, "/XML", target.spec]);
  } else if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${target.task}</string><key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>--no-warnings</string><string>${xmlEscape(SCRIPT_PATH)}</string><string>sync</string><string>--config</string><string>${xmlEscape(file)}</string><string>--quiet</string></array><key>StartInterval</key><integer>${minutes * 60}</integer><key>RunAtLoad</key><true/></dict></plist>`;
    atomicWrite(target.spec, plist, dryRun);
    if (!dryRun) run("launchctl", ["load", "-w", target.spec]);
  } else throw new CodexSyncError("Automatic install currently supports Windows Task Scheduler and macOS LaunchAgents.");
  return { action: dryRun ? "install-preview" : "installed", minutes, ...target, executable: process.execPath, script: SCRIPT_PATH, config: file };
}

function helpText() {
  return `Codex Sync v${PACKAGE_VERSION}\n\nCLI command: codexsync\n\nCommands:\n  init --vault PATH [--transport folder|git] [--repo URL]\n  vault use --vault PATH [--transport folder|git] [--repo URL]\n  sync|push|pull [--dry-run]\n  status | doctor\n  maintenance on|off|status [--reason TEXT]\n  conversation select <current|id|title>\n  conversation unselect <id|title>\n  conversation list\n  conversation audit <current|id|title>\n  conversation repair <current|id|title> [--title TITLE]\n  conversation resolve <id> --from-device DEVICE\n  skills list|discover\n  skills add --name NAME --path PATH [--exclude NAME]\n  skills remove NAME\n  skills install NAME --to PATH\n  project discover | project catalogs\n  project add|select <current|PATH> [--id ID] [--label LABEL] [--share-with all|DEVICE] [--ignore PATTERN] [--no-tasks]\n  project tasks <current|PATH>\n  project accept <ID> --path PATH [--no-register]\n  project map --from SOURCE_PATH --to LOCAL_PATH | project register <current|PATH>\n  project list | project status <ID|PATH> | project rescan <ID|PATH>\n  project remove <ID|PATH>  (registration only; keeps local files)\n  syncthing configure --syncthing-exe PATH | syncthing status\n  syncthing add-device --device-id ID [--name NAME]\n  device report | device list\n  daemon install|uninstall|status [--minutes 5] [--dry-run]\n\nGlobal options: --config PATH --json --quiet`;
}

function printResult(result, options) {
  if (options.quiet) return;
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (typeof result === "string") console.log(result);
  else console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command = "help", subcommand, ...rest] = positional;
  if (options.help || ["help", "--help", "-h"].includes(command)) return printResult(helpText(), options);
  let result;
  if (command === "init") result = initCommand(options);
  else if (command === "vault") result = vaultCommand(options, subcommand);
  else if (command === "maintenance") result = maintenanceCommand(options, subcommand ?? "status");
  else if (command === "project") result = await projectCommand(options, subcommand ?? "list", rest);
  else if (command === "syncthing") result = syncthingCommand(options, subcommand ?? "status");
  else if (command === "device") result = deviceCommand(options, subcommand ?? "list");
  else if (["sync", "push", "pull"].includes(command)) result = syncCommand(options, command);
  else if (command === "status") result = statusCommand(options);
  else if (command === "doctor") result = doctorCommand(options);
  else if (command === "conversation") {
    if (subcommand === "select") result = selectConversation(options, rest.join(" "), true);
    else if (subcommand === "unselect") result = selectConversation(options, rest.join(" "), false);
    else if (subcommand === "list") result = listConversationSelections(options);
    else if (subcommand === "audit") result = auditConversationCommand(options, rest.join(" ") || "current");
    else if (subcommand === "repair") result = repairConversationCommand(options, rest.join(" ") || "current");
    else if (subcommand === "resolve") result = resolveConversationConflict(options, rest[0]);
    else throw new CodexSyncError(`Unknown conversation action: ${subcommand}`);
  } else if (command === "skills") result = skillsCommand(options, subcommand ?? "list", rest);
  else if (command === "daemon") result = daemonCommand(options, subcommand ?? "status");
  else throw new CodexSyncError(`Unknown command: ${command}`);
  printResult(result, options);
}

main().catch((error) => {
  const message = error instanceof CodexSyncError ? error.message : `${error.name}: ${error.message}`;
  console.error(`codex-sync: ${message}`);
  if (process.env.CODEX_SYNC_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
