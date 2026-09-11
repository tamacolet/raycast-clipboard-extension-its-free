#!/usr/bin/env node
// Import a Raycast "Export Settings & Data" .rayconfig into the Clipboard Vault database.
//
// Usage:
//   node scripts/import-raycast.mjs <export.rayconfig> [--password <pass>] [--no-images] [--dry-run]
//
// Notes:
// - Decrypts the v1 .rayconfig format (IV + AES-256-CBC(gzip(JSON)), key = SHA256(passphrase)).
// - Text hash uses the same djb2 scheme as the Swift daemon, so entries already captured
//   by the daemon are skipped.
// - Images are copied into the vault's images directory and keyed by Raycast's imageHash.
// - Stop the daemon before importing (launchctl bootout gui/$UID/com.kandotrun.clipboard-vault).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const file = args[0];
if (!file || !fs.existsSync(file)) {
  console.error(
    "Usage: node scripts/import-raycast.mjs <export.rayconfig> [--password <pass>] [--no-images] [--dry-run]",
  );
  process.exit(1);
}
const flag = (name) => args.includes(name);
const passwordArg = args.indexOf("--password");
const password = passwordArg >= 0 ? args[passwordArg + 1] : "";
const noImages = flag("--no-images");
const dryRun = flag("--dry-run");

function decrypt(buffer, pass) {
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return zlib.gunzipSync(buffer);
  if (!pass) throw new Error("export is encrypted; pass --password <pass>");
  const iv = buffer.subarray(0, 16);
  const key = crypto.createHash("sha256").update(pass).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let plain = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]);
  if (plain[0] === 0x1f && plain[1] === 0x8b) plain = zlib.gunzipSync(plain);
  return plain;
}

function djb2(text) {
  let hash = 5381n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(text, "utf8")) {
    hash = ((hash << 5n) + hash + BigInt(byte)) & mask;
  }
  return hash.toString(16);
}

function sourceName(applicationPath) {
  if (!applicationPath) return null;
  let name = path.basename(applicationPath);
  if (name.endsWith(".app")) name = name.slice(0, -4);
  return name || null;
}

function detectType(text) {
  if (/^https?:\/\//.test(text)) return "url";
  if (text.startsWith("/") && fs.existsSync(text)) return "path";
  if (text.includes("@") && text.includes(".") && !text.includes(" ")) return "email";
  return "text";
}

const configPath = path.join(os.homedir(), ".clipboard-vault", "config.json");
let dbPath = path.join(os.homedir(), ".clipboard-vault", "clipboard.db");
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof config.dbPath === "string" && config.dbPath) {
    dbPath = config.dbPath.replace(/^~/, os.homedir());
  }
} catch {
  // no config yet; use default path
}

const json = JSON.parse(decrypt(fs.readFileSync(file), password).toString("utf8"));
const records =
  json["builtin_package_clipboardHistory"]?.["clipboardHistoryRecords"] ?? [];
if (records.length === 0) {
  console.error("No clipboard records found in this export.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 10000");
const exists = db.prepare(
  "SELECT 1 FROM clipboard WHERE content_hash = ? LIMIT 1",
);
const insert = db.prepare(
  "INSERT INTO clipboard (content, content_type, source_app, content_hash, created_at, pinned) VALUES (?, ?, ?, ?, ?, 0)",
);

const imagesDir = path.join(path.dirname(dbPath), "images");
if (!dryRun) fs.mkdirSync(imagesDir, { recursive: true });

const stats = {
  text: 0,
  image: 0,
  duplicate: 0,
  missingImage: 0,
  empty: 0,
  bytes: 0,
};

records.sort(
  (a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0),
);

if (!dryRun) db.exec("BEGIN");
try {
  for (const record of records) {
    const createdAt = Date.parse(record.createdAt ?? "") / 1000;
    if (!Number.isFinite(createdAt)) continue;
    const sourceApp = sourceName(record.applicationPath);

    if (record.category === "image") {
      if (noImages || !record.filePath) continue;
      if (!fs.existsSync(record.filePath)) {
        stats.missingImage++;
        continue;
      }
      const hash =
        record.imageHash ||
        crypto.createHash("sha256").update(fs.readFileSync(record.filePath)).digest("hex");
      if (exists.get(hash)) {
        stats.duplicate++;
        continue;
      }
      const target = path.join(imagesDir, `${hash}.png`);
      if (!dryRun) {
        if (!fs.existsSync(target)) {
          fs.copyFileSync(record.filePath, target);
          stats.bytes += fs.statSync(target).size;
        }
        insert.run(target, "image", sourceApp, hash, createdAt);
      }
      stats.image++;
      continue;
    }

    const text = typeof record.text === "string" ? record.text : "";
    if (!text) {
      stats.empty++;
      continue;
    }
    const hash = djb2(text);
    if (exists.get(hash)) {
      stats.duplicate++;
      continue;
    }
    if (!dryRun) insert.run(text, detectType(text), sourceApp, hash, createdAt);
    stats.text++;
  }
  if (!dryRun) db.exec("COMMIT");
} catch (error) {
  if (!dryRun) db.exec("ROLLBACK");
  throw error;
}
db.close();

console.log(`${dryRun ? "[dry-run] " : ""}imported: text=${stats.text} image=${stats.image}`);
console.log(
  `skipped: duplicate=${stats.duplicate} missing image=${stats.missingImage} empty=${stats.empty}`,
);
if (stats.image > 0) {
  console.log(`copied image bytes: ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
}
