#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairedDocs = [
  ["README.md", "README.zh-CN.md"],
  ["SECURITY.md", "SECURITY.zh-CN.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"],
  ["CHANGELOG.md", "CHANGELOG.zh-CN.md"],
  ["docs/demo.md", "docs/demo.zh-CN.md"],
  ["docs/roadmap.md", "docs/roadmap.zh-CN.md"],
  ["docs/architecture.md", "docs/architecture.zh-CN.md"],
];

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function headings(markdown) {
  return markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.match(/^#+/)[0].length);
}

function fenceCount(markdown) {
  return markdown.split(/\r?\n/).filter((line) => /^```/.test(line)).length;
}

const findings = [];
for (const file of walk(root)) {
  const markdown = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).split(path.sep).join("/");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) findings.push(`${rel}: broken local link ${match[1]}`);
  }
}

for (const [english, chinese] of pairedDocs) {
  const enPath = path.join(root, english);
  const zhPath = path.join(root, chinese);
  if (!fs.existsSync(enPath) || !fs.existsSync(zhPath)) {
    findings.push(`${english} / ${chinese}: missing language pair`);
    continue;
  }
  const en = fs.readFileSync(enPath, "utf8");
  const zh = fs.readFileSync(zhPath, "utf8");
  const enLink = path.basename(chinese);
  const zhLink = path.basename(english);
  if (!en.includes(`](${enLink})`)) findings.push(`${english}: missing relative language switcher to ${enLink}`);
  if (!zh.includes(`](${zhLink})`)) findings.push(`${chinese}: missing relative language switcher to ${zhLink}`);
  if (JSON.stringify(headings(en)) !== JSON.stringify(headings(zh))) findings.push(`${english} / ${chinese}: heading-level structure differs`);
  if (fenceCount(en) !== fenceCount(zh)) findings.push(`${english} / ${chinese}: fenced-code structure differs`);
}

if (findings.length) {
  console.error("Documentation check failed:");
  for (const finding of findings.sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed (${walk(root).length} Markdown files, ${pairedDocs.length} language pairs).`);
}
