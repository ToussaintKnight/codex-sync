#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), "sync2.mjs");
const SKILL_ROOT = path.dirname(path.dirname(CLI));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync2-e2e-"));
const vault = path.join(root, "vault");
const id = "019f0000-0000-7000-8000-000000000001";
const damagedId = "019f0000-0000-7000-8000-000000000002";

function run(args, env = {}) {
  const output = execFileSync(process.execPath, [CLI, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
  });
  return JSON.parse(output);
}

function runFails(args, env = {}) {
  try {
    run(args, env);
  } catch (error) {
    return `${error.stderr ?? ""}${error.stdout ?? ""}${error.message ?? ""}`;
  }
  throw new Error(`Expected command to fail: ${args.join(" ")}`);
}

function record(type, payload, timestamp = "2026-01-01T00:00:00.000Z") {
  return JSON.stringify({ timestamp, type, payload });
}

function makeHome(name) {
  const home = path.join(root, name);
  const sessionDir = path.join(home, "sessions", "2026", "01", "01");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(home, "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, "sqlite"), { recursive: true });
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '', created_at_ms INTEGER, updated_at_ms INTEGER,
    recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0
  )`);
  db.close();
  const appDb = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
  appDb.exec(`CREATE TABLE local_thread_catalog (
    host_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_title TEXT NOT NULL,
    source_created_at REAL NOT NULL, source_updated_at REAL NOT NULL, cwd TEXT NOT NULL,
    source_kind TEXT NOT NULL, source_detail TEXT, model_provider TEXT NOT NULL,
    git_branch TEXT, observation_sequence INTEGER NOT NULL, missing_candidate INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host_id, thread_id)
  );
  CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT NOT NULL);
  CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, watermark_updated_at REAL, initial_build_complete INTEGER NOT NULL DEFAULT 0, observation_sequence INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER NOT NULL DEFAULT 0);
  INSERT INTO local_thread_catalog_hosts VALUES ('local','local');
  INSERT INTO local_thread_catalog_sync_state VALUES ('local',NULL,1,7);
  INSERT INTO local_thread_catalog_metadata VALUES (1,0);`);
  appDb.close();
  return { home, sessionDir };
}

function createThread(homeInfo) {
  const rollout = path.join(homeInfo.sessionDir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const lines = [
    record("session_meta", { id, timestamp: "2026-01-01T00:00:00.000Z", cwd: path.join(root, "project"), originator: "test", cli_version: "1.0", source: "cli", model_provider: "openai" }),
    record("event_msg", { type: "user_message", message: "portable hello" }),
  ];
  fs.writeFileSync(rollout, `${lines.join("\n")}\n`);
  const db = new DatabaseSync(path.join(homeInfo.home, "state_5.sqlite"));
  db.prepare("INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,tokens_used,has_user_event,archived,cli_version,first_user_message,preview,created_at_ms,updated_at_ms,recency_at,recency_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, rollout, 1767225600, 1767225600, "cli", "openai", path.join(root, "project"), "Sync2 E2E Thread", "{}", "never", 1, 1, 0, "1.0", "portable hello", "portable hello", 1767225600000, 1767225600000, 1767225600, 1767225600000);
  db.close();
  fs.writeFileSync(path.join(homeInfo.home, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: "Sync2 E2E Thread", updated_at: "2026-01-01T00:00:00.000Z" })}\n`);
  return rollout;
}

function append(file, message) {
  fs.appendFileSync(file, `${record("event_msg", { type: "user_message", message }, new Date().toISOString())}\n`);
}

function findRollout(home, targetId = id) {
  const stack = [path.join(home, "sessions")];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(`${targetId}.jsonl`)) return full;
    }
  }
  return null;
}

try {
  const a = makeHome("home-a");
  const b = makeHome("home-b");
  const rolloutA = createThread(a);
  const skillA = path.join(a.home, "skills", "portable-skill");
  fs.mkdirSync(skillA, { recursive: true });
  fs.writeFileSync(path.join(skillA, "SKILL.md"), "version a1\n");
  const configA = path.join(root, "profile-a", "config.json");
  const configB = path.join(root, "profile-b", "config.json");

  run(["init", "--vault", vault, "--transport", "folder", "--device", "win-a", "--codex-home", a.home, "--config", configA]);
  run(["init", "--vault", vault, "--transport", "folder", "--device", "mac-b", "--codex-home", b.home, "--config", configB]);
  run(["conversation", "select", "current", "--config", configA], { CODEX_THREAD_ID: id });
  const first = run(["sync", "--config", configA]);
  assert.equal(first.conversationsPushed, 1);
  assert.ok(first.skillFilesPushed >= 1);
  const selectionFile = path.join(vault, ".sync2", "selections", "win-a.json");
  const headFile = path.join(vault, "conversations", id, "heads", "win-a.jsonl");
  const canonicalFile = path.join(vault, "conversations", id, "canonical.jsonl");
  const unchangedBefore = [selectionFile, headFile, canonicalFile].map((file) => fs.statSync(file).mtimeMs);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  run(["sync", "--config", configA]);
  const unchangedAfter = [selectionFile, headFile, canonicalFile].map((file) => fs.statSync(file).mtimeMs);
  assert.deepEqual(unchangedAfter, unchangedBefore);
  const activeCheckpointTurn = "turn-active-checkpoint";
  fs.appendFileSync(rolloutA, `${record("event_msg", { type: "task_started", turn_id: activeCheckpointTurn })}\n${record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "not stable yet" }], internal_chat_message_metadata_passthrough: { turn_id: activeCheckpointTurn } })}\n`);
  const checkpointSync = run(["sync", "--config", configA]);
  assert.equal(checkpointSync.conversationCheckpoints, 1);
  assert.doesNotMatch(fs.readFileSync(headFile, "utf8"), /not stable yet/);
  fs.appendFileSync(rolloutA, `${record("event_msg", { type: "task_complete", turn_id: activeCheckpointTurn })}\n`);
  run(["sync", "--config", configA]);
  assert.match(fs.readFileSync(headFile, "utf8"), /not stable yet/);

  const pullB = run(["sync", "--config", configB]);
  assert.equal(pullB.conversationsPulled, 1);
  assert.ok(pullB.skillFilesPulled >= 1);
  const rolloutB = findRollout(b.home);
  assert.ok(rolloutB);
  assert.equal(fs.readFileSync(rolloutB, "utf8"), fs.readFileSync(rolloutA, "utf8"));
  assert.equal(fs.readFileSync(path.join(b.home, "skills", "portable-skill", "SKILL.md"), "utf8"), "version a1\n");
  const reportB = JSON.parse(fs.readFileSync(path.join(vault, ".sync2", "device-reports", "mac-b.json"), "utf8"));
  assert.equal(reportB.selectedConversations[0].rolloutExists, true);
  assert.equal(reportB.selectedConversations[0].indexedInStateDb, true);
  assert.ok(reportB.skillSources[0].files >= 1);
  assert.equal(reportB.lastRun.ok, true);
  assert.equal(reportB.lastRun.summary.conversationsPulled, pullB.conversationsPulled);
  assert.equal(reportB.lastRun.summary.skillFilesPulled, pullB.skillFilesPulled);
  const dbB = new DatabaseSync(path.join(b.home, "state_5.sqlite"));
  assert.equal(dbB.prepare("SELECT title FROM threads WHERE id=?").get(id).title, "Sync2 E2E Thread");
  dbB.close();
  const appDbB = new DatabaseSync(path.join(b.home, "sqlite", "codex-dev.db"));
  assert.equal(appDbB.prepare("SELECT display_title FROM local_thread_catalog WHERE thread_id=?").get(id).display_title, "Sync2 E2E Thread");
  assert.equal(appDbB.prepare("SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id=1").get().catalog_revision, 1);
  appDbB.close();

  append(rolloutB, "continued on B");
  run(["sync", "--config", configB]);
  run(["sync", "--config", configA]);
  assert.match(fs.readFileSync(rolloutA, "utf8"), /continued on B/);

  fs.writeFileSync(path.join(skillA, "SKILL.md"), "version a2\n");
  run(["sync", "--config", configA]);
  run(["sync", "--config", configB]);
  assert.equal(fs.readFileSync(path.join(b.home, "skills", "portable-skill", "SKILL.md"), "utf8"), "version a2\n");

  fs.writeFileSync(path.join(skillA, "SKILL.md"), "version a3\n");
  fs.writeFileSync(path.join(b.home, "skills", "portable-skill", "SKILL.md"), "version b3\n");
  run(["sync", "--config", configA]);
  const skillConflict = run(["sync", "--config", configB]);
  assert.equal(skillConflict.skillConflicts, 1);
  assert.equal(fs.readFileSync(path.join(b.home, "skills", "portable-skill", "SKILL.md"), "utf8"), "version b3\n");
  assert.ok(skillConflict.warnings.some((item) => item.includes("Skill conflict")));

  run(["sync", "--config", configA]);
  run(["sync", "--config", configB]);
  append(rolloutA, "branch A");
  append(rolloutB, "branch B");
  run(["sync", "--config", configA]);
  const conversationConflict = run(["sync", "--config", configB]);
  assert.equal(conversationConflict.conversationConflicts >= 1, true);
  assert.ok(fs.existsSync(path.join(vault, "conversations", id, "conflict.json")));
  assert.match(fs.readFileSync(rolloutA, "utf8"), /branch A/);
  assert.match(fs.readFileSync(rolloutB, "utf8"), /branch B/);

  const resolvedB = run(["conversation", "resolve", id, "--from-device", "win-a", "--config", configB]);
  assert.equal(resolvedB.action, "resolved");
  assert.match(fs.readFileSync(rolloutB, "utf8"), /branch A/);
  assert.doesNotMatch(fs.readFileSync(rolloutB, "utf8"), /branch B/);
  run(["sync", "--config", configB]);
  assert.ok(!fs.existsSync(path.join(vault, "conversations", id, "conflict.json")));

  const preview = run(["sync", "--dry-run", "--config", configA]);
  assert.equal(preview.dryRun, true);
  const daemonPreview = run(["daemon", "install", "--dry-run", "--minutes", "3", "--config", configA]);
  assert.equal(daemonPreview.action, "install-preview");
  const doctor = run(["doctor", "--config", configA]);
  assert.equal(doctor.ok, true);
  const status = run(["status", "--config", configA]);
  assert.equal(status.selectedConversations.length, 1);

  const damagedVault = path.join(root, "damaged-vault");
  const damagedA = makeHome("home-damaged-a");
  const damagedB = makeHome("home-damaged-b");
  const damagedRollout = path.join(damagedA.sessionDir, `rollout-2026-01-01T00-00-00-${damagedId}.jsonl`);
  const oldTurn = "turn-old";
  const currentTurn = "turn-current";
  const missingCall = "call-missing-output";
  fs.writeFileSync(damagedRollout, [
    record("session_meta", { id: damagedId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root, cli_version: "1.0", model_provider: "openai" }),
    record("event_msg", { type: "task_started", turn_id: oldTurn }),
    record("response_item", { type: "custom_tool_call", call_id: missingCall, name: "exec", input: "{}", internal_chat_message_metadata_passthrough: { turn_id: oldTurn } }),
    record("event_msg", { type: "task_started", turn_id: currentTurn }),
  ].join("\n") + "\n");
  const damagedDb = new DatabaseSync(path.join(damagedA.home, "state_5.sqlite"));
  const storedDamagedPath = process.platform === "win32" ? `\\\\?\\${damagedRollout}` : damagedRollout;
  damagedDb.prepare("INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,tokens_used,has_user_event,archived,cli_version,first_user_message,preview,created_at_ms,updated_at_ms,recency_at,recency_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(damagedId, storedDamagedPath, 1767225600, 1767225600, "cli", "openai", root, "Damaged Thread", "{}", "never", 1, 1, 0, "1.0", "damaged", "damaged", 1767225600000, 1767225600000, 1767225600, 1767225600000);
  damagedDb.close();
  fs.writeFileSync(path.join(damagedA.home, "session_index.jsonl"), `${JSON.stringify({ id: damagedId, thread_name: "", updated_at: "2026-01-01T00:00:00.000Z" })}\n`);
  const damagedConfigA = path.join(root, "profile-damaged-a", "config.json");
  const damagedConfigB = path.join(root, "profile-damaged-b", "config.json");
  run(["init", "--vault", damagedVault, "--device", "win-c", "--codex-home", damagedA.home, "--config", damagedConfigA]);
  run(["conversation", "select", "current", "--config", damagedConfigA], { CODEX_THREAD_ID: damagedId });
  const damagedAudit = run(["conversation", "audit", damagedId, "--config", damagedConfigA]);
  assert.equal(damagedAudit.rollout.persistentDanglingCalls.length, 1);
  assert.equal(damagedAudit.rollout.staleOpenTurns.length, 1);
  assert.ok(!damagedAudit.rollout.file.startsWith("\\\\?\\"));
  const skippedDamaged = run(["sync", "--config", damagedConfigA]);
  assert.ok(skippedDamaged.conversationsSkipped >= 1);
  assert.ok(!fs.existsSync(path.join(damagedVault, "conversations", damagedId, "heads", "win-c.jsonl")));

  const damagedConversationRoot = path.join(damagedVault, "conversations", damagedId);
  fs.mkdirSync(path.join(damagedConversationRoot, "heads"), { recursive: true });
  fs.copyFileSync(damagedRollout, path.join(damagedConversationRoot, "heads", "broken-device.jsonl"));
  fs.copyFileSync(damagedRollout, path.join(damagedConversationRoot, "canonical.jsonl"));
  fs.writeFileSync(path.join(damagedConversationRoot, "metadata.json"), `${JSON.stringify({ version: 1, id: damagedId, title: "Damaged Thread", createdAt: "2026-01-01T00:00:00.000Z", relativePath: `sessions/2026/01/01/${path.basename(damagedRollout)}`, cwd: root, modelProvider: "openai" }, null, 2)}\n`);
  run(["init", "--vault", damagedVault, "--device", "mac-c", "--codex-home", damagedB.home, "--config", damagedConfigB]);
  const rejectedPull = run(["pull", "--config", damagedConfigB]);
  assert.ok(rejectedPull.conversationsSkipped >= 1);
  assert.equal(findRollout(damagedB.home, damagedId), null);

  const repaired = run(["conversation", "repair", damagedId, "--title", "Repaired Thread", "--config", damagedConfigA]);
  assert.deepEqual(repaired.repairedCalls, [missingCall]);
  assert.deepEqual(repaired.closedStaleTurns, [oldTurn]);
  assert.equal(repaired.semanticOkAfter, true);
  assert.equal(repaired.indexesConsistent, true);
  fs.appendFileSync(damagedRollout, `${record("event_msg", { type: "task_complete", turn_id: currentTurn })}\n`);
  const repairedSync = run(["sync", "--config", damagedConfigA]);
  assert.equal(repairedSync.conversationsPushed, 1);
  const repairedCanonical = fs.readFileSync(path.join(damagedConversationRoot, "canonical.jsonl"), "utf8");
  assert.match(repairedCanonical, /custom_tool_call_output/);
  assert.match(repairedCanonical, /recovered_stale_turn/);
  const repairedAudit = run(["conversation", "audit", damagedId, "--config", damagedConfigA]);
  assert.equal(repairedAudit.rollout.projectionUnsafeAbortEvents.length, 0);
  const repairedAbort = repairedCanonical.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .find((item) => item.type === "event_msg" && item.payload?.type === "turn_aborted" && item.payload?.turn_id === oldTurn);
  assert.equal(repairedAbort.payload.reason, "interrupted");
  assert.equal(Number.isFinite(repairedAbort.payload.completed_at), true);
  assert.equal(Number.isFinite(repairedAbort.payload.duration_ms), true);
  assert.ok(fs.existsSync(path.join(damagedConversationRoot, "metadata", "win-c.json")));
  const repairedPull = run(["pull", "--config", damagedConfigB]);
  assert.equal(repairedPull.conversationsPulled, 1);
  assert.ok(findRollout(damagedB.home, damagedId));

  const legacyAbortTurn = "turn-legacy-projection-abort";
  fs.appendFileSync(damagedRollout, `${record("event_msg", { type: "task_started", turn_id: legacyAbortTurn, started_at: 1767225900 })}\n${record("event_msg", { type: "turn_aborted", turn_id: legacyAbortTurn, reason: "recovered_stale_turn" })}\n`);
  const legacyAbortAudit = run(["conversation", "audit", damagedId, "--config", damagedConfigA]);
  assert.equal(legacyAbortAudit.rollout.semanticOk, false);
  assert.equal(legacyAbortAudit.rollout.projectionUnsafeAbortEvents.length, 1);
  const legacyAbortRepair = run(["conversation", "repair", damagedId, "--config", damagedConfigA]);
  assert.deepEqual(legacyAbortRepair.closedStaleTurns, [legacyAbortTurn]);
  assert.equal(legacyAbortRepair.semanticOkAfter, true);
  const legacyAbortAfter = run(["conversation", "audit", damagedId, "--config", damagedConfigA]);
  assert.equal(legacyAbortAfter.rollout.projectionUnsafeAbortEvents.length, 0);
  const legacyAbortEvents = fs.readFileSync(damagedRollout, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((item) => item.type === "event_msg" && item.payload?.type === "turn_aborted" && item.payload?.turn_id === legacyAbortTurn);
  assert.equal(legacyAbortEvents.at(-1).payload.reason, "interrupted");
  assert.equal(Number.isFinite(legacyAbortEvents.at(-1).payload.completed_at), true);
  assert.equal(Number.isFinite(legacyAbortEvents.at(-1).payload.duration_ms), true);

  run(["maintenance", "on", "--reason", "test", "--config", damagedConfigA]);
  assert.match(runFails(["sync", "--config", damagedConfigA]), /maintenance mode is enabled/);
  const maintenanceStatus = run(["maintenance", "status", "--config", damagedConfigA]);
  assert.equal(maintenanceStatus.enabled, true);
  run(["maintenance", "off", "--config", damagedConfigA]);

  if (process.platform === "win32") {
    const bootstrapVault = path.join(root, "bootstrap-maintenance-vault");
    const bootstrapSkill = path.join(bootstrapVault, "skills", "codex", "sync2");
    fs.mkdirSync(path.dirname(bootstrapSkill), { recursive: true });
    fs.cpSync(SKILL_ROOT, bootstrapSkill, { recursive: true });
    fs.mkdirSync(path.join(bootstrapVault, ".sync2"), { recursive: true });
    fs.writeFileSync(path.join(bootstrapVault, ".sync2", "maintenance.json"), `${JSON.stringify({ enabled: true, reason: "bootstrap test" })}\n`);
    const bootstrapHome = makeHome("home-bootstrap-win");
    const bootstrapConfig = path.join(root, "profile-bootstrap-win", "config.json");
    execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SKILL_ROOT, "scripts", "bootstrap-sync2.ps1"),
      "-Vault", bootstrapVault, "-Device", "bootstrap-win", "-CodexHome", bootstrapHome.home, "-Config", bootstrapConfig,
    ], { stdio: "ignore", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    assert.ok(fs.existsSync(bootstrapConfig));
    assert.ok(fs.existsSync(path.join(bootstrapHome.home, "skills", "sync2", "scripts", "sync2.mjs")));
    const bootstrapLastRun = JSON.parse(fs.readFileSync(path.join(path.dirname(bootstrapConfig), "runs", "bootstrap-win-last.json"), "utf8"));
    assert.equal(bootstrapLastRun.ok, true);
    assert.ok(fs.existsSync(path.join(bootstrapVault, ".sync2", "maintenance.json")));
  }

  const gitHome = makeHome("home-git");
  const gitSkill = path.join(gitHome.home, "skills", "git-skill");
  fs.mkdirSync(gitSkill, { recursive: true });
  fs.writeFileSync(path.join(gitSkill, "SKILL.md"), "git transport\n");
  const gitVault = path.join(root, "git-vault");
  fs.mkdirSync(gitVault, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: gitVault, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Sync2 Test"], { cwd: gitVault });
  execFileSync("git", ["config", "user.email", "sync2-test@example.invalid"], { cwd: gitVault });
  const gitConfig = path.join(root, "profile-git", "config.json");
  run(["init", "--vault", gitVault, "--transport", "git", "--device", "git-device", "--codex-home", gitHome.home, "--config", gitConfig]);
  const gitSync = run(["sync", "--config", gitConfig]);
  assert.ok(gitSync.skillFilesPushed >= 1);
  const gitLog = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: gitVault, encoding: "utf8" });
  assert.match(gitLog, /^sync2: git-device/);
  assert.ok(fs.existsSync(path.join(gitVault, "skills", "codex", "git-skill", "SKILL.md")));

  const relocatedVault = path.join(root, "relocated-vault");
  const relocation = run(["vault", "use", "--vault", relocatedVault, "--transport", "folder", "--config", gitConfig]);
  assert.equal(relocation.action, "vault-updated");
  assert.ok(fs.existsSync(path.join(relocatedVault, "skills", "codex", "git-skill", "SKILL.md")));

  console.log(JSON.stringify({ ok: true, root, checks: 65, deviceReports: true, noOpWrites: true, stableActiveCheckpoint: true, extendedWindowsPath: true, semanticRepair: true, legacyAbortRepair: true, unsafeCanonicalQuarantine: true, activeTurnProtection: true, perDeviceMetadata: true, desktopCatalogImport: true, maintenanceMode: true, maintenanceBootstrap: process.platform === "win32", folderTransport: true, gitTransport: true, vaultRelocation: true, conversationImport: true, skillThreeWay: true, conflictRecovery: true, daemonPreview: true }, null, 2));
} catch (error) {
  console.error(`E2E FAILED; artifacts kept at ${root}`);
  throw error;
} finally {
  if (process.exitCode !== 1 && !process.env.SYNC2_KEEP_TEST) fs.rmSync(root, { recursive: true, force: true });
}
