#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannerRelativePath = "scripts/check-repo-hygiene.mjs";
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist", "tmp"]);
const textExtensions = new Set(["", ".md", ".mjs", ".js", ".json", ".yaml", ".yml", ".ps1", ".sh", ".txt"]);

const forbiddenFileRules = [
  { name: "local state directory", test: (value) => value.split("/").some((part) => [".codex-sync", ".codex", "CodexSyncVault", "recovery", "device-reports"].includes(part)) },
  { name: "credential/config file", test: (value) => /(^|\/)(auth\.json|config\.toml|\.env(?:\..*)?)$/i.test(value) && !value.endsWith("/.env.example") },
  { name: "database or conversation artifact", test: (value) => /\.(?:sqlite|sqlite3|db|jsonl)(?:-wal|-shm)?$/i.test(value) },
  { name: "private key material", test: (value) => /(^|\/)(?:id_rsa.*|id_ed25519.*|.*\.(?:pem|key))$/i.test(value) },
  { name: "transport conflict artifact", test: (value) => /\.sync-conflict-/i.test(value) },
];

const contentRules = [
  { name: "private key block", pattern: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "literal secret assignment", pattern: /\b(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*["'][^"'\r\n]{16,}["']/gi },
  { name: "private home path", pattern: /(?:[A-Za-z]:\\Users\\[^\\\s<>:"']+\\|\/Users\/[^/\s<>:"']+\/|\/home\/[^/\s<>:"']+\/)/g },
  { name: "Syncthing device ID", pattern: /\b[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}\b/g },
  { name: "private-network IP", pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g },
  { name: "non-example email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, allow: (value) => /@(example\.(?:com|org|net)|[^@]+\.invalid|users\.noreply\.github\.com)$/i.test(value) },
];

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

const findings = [];
for (const file of walk(root)) {
  const rel = relative(file);
  for (const rule of forbiddenFileRules) {
    if (rule.test(rel)) findings.push(`${rel}: forbidden ${rule.name}`);
  }

  if (rel === scannerRelativePath || !textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("\0")) continue;
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      if (rule.allow?.(match[0])) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      findings.push(`${rel}:${line}: ${rule.name}`);
    }
  }
}

if (findings.length) {
  console.error("Repository privacy gate failed:");
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Repository privacy gate passed (${walk(root).length} files scanned).`);
}
