#!/usr/bin/env node
/**
 * secret-scan.mjs — «агент по безопасности» репозитория dsh-lightrag.
 *
 * Блокирует в репозиторий (рабочее дерево + полную git-историю):
 *   1. Запрещённые пути: .env*, *.pem, *.key, id_rsa*, rag_storage/, inputs/,
 *      logs/, бэкапы/архивы с локальным состоянием.
 *   2. Известные форматы секретов: GitHub/OpenAI/Anthropic/AWS/Slack/Telegram/JWT,
 *      private key-блоки.
 *   3. Общие паттерны: api_key/secret/token/password = <значение 16+ символов>,
 *      кроме явных плейсхолдеров (not-needed, ollama, changeme, <...>, $VAR…).
 *
 * Запуск:
 *   node scripts/secret-scan.mjs            — рабочее дерево + вся история
 *   node scripts/secret-scan.mjs --tree     — только рабочее дерево (быстро)
 *
 * Выход: 0 — чисто; 1 — найдены нарушения (pre-push блокирует пуш).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TREE_ONLY = process.argv.includes("--tree");

// --- 1. Запрещённые пути ---
const PATH_BLOCKLIST = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /^rag_storage\//,
  /^inputs\//,
  /^logs\//,
  /(^|\/)__parsed__\//,
  /^backup-.*\.(tar\.gz|tar|zip)$/,
  /\.tar\.gz$/,
  /\.zip$/,
];

// --- 2. Известные форматы секретов ---
const SECRET_PATTERNS = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9]{24,}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY/],
  // --- 3. Общие: присваивание длинного значения ---
  ["api key/secret assignment",
   /\b(api[_-]?key|apikey|secret|token|passw(?:or)?d|client[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9+\/_\-]{16,})["']?/i],
];

const PLACEHOLDER = /(^|["'\s])?(not-needed|ollama|changeme|placeholder|xxx+|dummy|example|test-key|none|null|true|false|Bearer probe|probe|\$\{?[A-Z_]+|<[^>]*>)/i;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const hits = [];
const scanContent = (where, text) => {
  for (const [label, re] of SECRET_PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const value = m[2] || m[0];
      if (PLACEHOLDER.test(value) || PLACEHOLDER.test(m[0].slice(m[0].indexOf(value) - 1))) continue;
      // строка вида LLM_BINDING_API_KEY=**** в примерах документации — пропускаем
      if (/^[\*\u2022]{4,}$/.test(value)) continue;
      hits.push({ where, label, snippet: m[0].slice(0, 80) });
      if (hits.length > 40) return;
    }
  }
};

const scanFile = (where, full) => {
  for (const re of PATH_BLOCKLIST) if (re.test(where)) { hits.push({ where, label: "blocked path", snippet: "" }); return; }
  let st;
  try { st = fs.statSync(full); } catch { return; }
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
  let text;
  try { text = fs.readFileSync(full, "utf8"); } catch { return; } // бинарники — только path-check
  if (/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/.test(text.slice(0, 4096))) return;
  scanContent(where, text);
};

// --- Рабочее дерево ---
const walk = (dir, rel = "") => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else scanFile(r, path.join(dir, e.name));
  }
};
walk(ROOT);

// --- Git-история (все коммиты, все ветки) ---
if (!TREE_ONLY) {
  let objects;
  try { objects = sh("git", ["rev-list", "--objects", "--all"]); }
  catch { objects = ""; }
  const lines = objects.split("\n").filter(Boolean);
  const seenBlobs = new Set();
  for (const line of lines) {
    const [oid, ...rest] = line.split(" ");
    const fp = rest.join(" ");
    if (!oid || !/^[0-9a-f]{40}$/.test(oid)) continue;
    for (const re of PATH_BLOCKLIST) if (re.test(fp)) { hits.push({ where: `history:${fp}`, label: "blocked path", snippet: "" }); break; }
    if (!/^[0-9a-f]{40}$/.test(oid) || seenBlobs.has(oid)) continue;
    let type = "";
    try { type = sh("git", ["cat-file", "-t", oid]).trim(); } catch { continue; }
    if (type !== "blob") { seenBlobs.add(oid); continue; }
    seenBlobs.add(oid);
    let text;
    try { text = sh("git", ["cat-file", "blob", oid]); } catch { continue; }
    if (text.length > 2 * 1024 * 1024) continue;
    scanContent(`history:${fp}`, text);
  }
}

if (hits.length === 0) {
  console.log(`secret-scan: чисто (дерево${TREE_ONLY ? "" : " + история"}).`);
  process.exit(0);
}
console.error(`secret-scan: НАЙДЕНО ${hits.length} нарушений:`);
for (const h of hits.slice(0, 40)) {
  console.error(`  [${h.label}] ${h.where}${h.snippet ? `  →  ${h.snippet}` : ""}`);
}
process.exit(1);
