import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  dir TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  capture_ms INTEGER NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  scan_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_time ON photos(capture_ms DESC, path);
CREATE INDEX IF NOT EXISTS photos_tree ON photos(year DESC, month DESC, day DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openLibrary(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export function upsertPhotos(db, photos, scanId) {
  if (!photos.length) return;
  const stmt = db.prepare(`
    INSERT INTO photos (path, name, ext, dir, size, mtime_ms, capture_ms, year, month, day, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      ext = excluded.ext,
      dir = excluded.dir,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      capture_ms = excluded.capture_ms,
      year = excluded.year,
      month = excluded.month,
      day = excluded.day,
      scan_id = excluded.scan_id
  `);
  db.exec("BEGIN");
  try {
    for (const photo of photos) {
      stmt.run(
        photo.path,
        photo.name,
        photo.ext,
        photo.dir,
        photo.size,
        photo.mtimeMs,
        photo.captureMs,
        photo.year,
        photo.month,
        photo.day,
        scanId,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function purgeScan(db, scanId) {
  db.prepare("DELETE FROM photos WHERE scan_id != ?").run(scanId);
}

export function setLibraryMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function libraryMeta(db) {
  const rows = db.prepare("SELECT key, value FROM meta").all();
  const meta = {};
  for (const row of rows) meta[row.key] = row.value;
  return meta;
}

export function libraryCount(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM photos").get().count;
}

export function libraryPhoto(db, filePath) {
  return db.prepare("SELECT path, name, ext, dir, size, mtime_ms AS mtimeMs, capture_ms AS captureMs, year, month, day FROM photos WHERE path = ?").get(filePath) || null;
}

export function libraryTree(db) {
  return db.prepare("SELECT year, month, day, COUNT(*) AS count FROM photos GROUP BY year, month, day ORDER BY year DESC, month DESC, day DESC").all();
}

export function queryPhotos(db, filter = {}) {
  const where = [];
  const params = [];
  if (filter.year) {
    where.push("year = ?");
    params.push(Number(filter.year));
  }
  if (filter.month) {
    where.push("month = ?");
    params.push(Number(filter.month));
  }
  if (filter.day) {
    where.push("day = ?");
    params.push(Number(filter.day));
  }
  const text = String(filter.q || "").trim().replace(/[%_]/g, "");
  if (text) {
    where.push("name LIKE ?");
    params.push(`%${text}%`);
  }
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 80));
  const offset = Math.max(0, Number(filter.offset) || 0);
  params.push(limit, offset);
  const sql = `
    SELECT path, name, ext, dir, capture_ms AS captureMs, year, month, day
    FROM photos
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY capture_ms DESC, path COLLATE NOCASE
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params);
}
