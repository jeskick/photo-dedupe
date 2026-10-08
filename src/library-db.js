import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bestName, bufferFromEmbedding, embeddingFromBuffer, facesToRename } from "./faces.js";

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
  const columns = db.prepare("PRAGMA table_info(photos)").all();
  if (!columns.some((column) => column.name === "rating")) {
    db.exec("ALTER TABLE photos ADD COLUMN rating INTEGER NOT NULL DEFAULT 0");
  }
  const again = db.prepare("PRAGMA table_info(photos)").all();
  if (!again.some((column) => column.name === "kind")) {
    db.exec("ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'");
  }
  if (!again.some((column) => column.name === "origin")) {
    db.exec("ALTER TABLE photos ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
  }
  if (!again.some((column) => column.name === "width")) {
    db.exec("ALTER TABLE photos ADD COLUMN width INTEGER NOT NULL DEFAULT 0");
  }
  if (!again.some((column) => column.name === "height")) {
    db.exec("ALTER TABLE photos ADD COLUMN height INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS photos_kind ON photos(kind, capture_ms DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS faces (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      embedding BLOB NOT NULL,
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS faces_path ON faces(path);
    CREATE INDEX IF NOT EXISTS faces_name ON faces(name);
    CREATE TABLE IF NOT EXISTS labels (
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (path, label)
    );
  `);
  return db;
}

export function upsertPhotos(db, photos, scanId) {
  if (!photos.length) return;
  const stmt = db.prepare(`
    INSERT INTO photos (path, name, ext, dir, size, mtime_ms, capture_ms, year, month, day, scan_id, kind, origin, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      scan_id = excluded.scan_id,
      kind = excluded.kind,
      origin = excluded.origin,
      width = excluded.width,
      height = excluded.height
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
        photo.kind === "video" ? "video" : "photo",
        photo.origin === "camera" || photo.origin === "phone" ? photo.origin : "",
        Number(photo.width) || 0,
        Number(photo.height) || 0,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function dropOrphanMarks(db) {
  db.exec("DELETE FROM faces WHERE path NOT IN (SELECT path FROM photos)");
  db.exec("DELETE FROM labels WHERE path NOT IN (SELECT path FROM photos)");
}

export function purgeScan(db, scanId, kind = "photo") {
  const media = kind === "video" ? "video" : "photo";
  const changes = db.prepare("DELETE FROM photos WHERE kind = ? AND scan_id != ?").run(media, scanId).changes || 0;
  if (changes) dropOrphanMarks(db);
  return changes;
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

export function libraryCount(db, kind) {
  if (kind === "photo" || kind === "video") {
    return db.prepare("SELECT COUNT(*) AS count FROM photos WHERE kind = ?").get(kind).count;
  }
  return db.prepare("SELECT COUNT(*) AS count FROM photos").get().count;
}

export function libraryPhoto(db, filePath) {
  return db.prepare("SELECT path, name, ext, dir, size, mtime_ms AS mtimeMs, capture_ms AS captureMs, year, month, day, rating, kind, origin, width, height FROM photos WHERE path = ?").get(filePath) || null;
}

const MIN_EDGES = new Set([0, 120, 240, 360, 480]);

export function librarySettings(db) {
  let parsed = {};
  try {
    parsed = JSON.parse(libraryMeta(db).librarySettings || "{}");
  } catch {
    parsed = {};
  }
  const minEdge = parsed.minEdge || {};
  const photoEdge = Number(minEdge.photo);
  const videoEdge = Number(minEdge.video);
  return {
    excludeDirs: Array.isArray(parsed.excludeDirs) ? parsed.excludeDirs.map((item) => String(item)).filter(Boolean) : [],
    minEdgePhoto: MIN_EDGES.has(photoEdge) ? photoEdge : 0,
    minEdgeVideo: MIN_EDGES.has(videoEdge) ? videoEdge : 0,
  };
}

export function saveLibrarySettings(db, input = {}) {
  const current = librarySettings(db);
  const excludeDirs = Array.isArray(input.excludeDirs)
    ? [...new Set(input.excludeDirs.map((item) => path.resolve(String(item || ""))).filter(Boolean))]
    : current.excludeDirs;
  const photoEdge = Number(input.minEdgePhoto);
  const videoEdge = Number(input.minEdgeVideo);
  const next = {
    excludeDirs,
    minEdge: {
      photo: MIN_EDGES.has(photoEdge) ? photoEdge : current.minEdgePhoto,
      video: MIN_EDGES.has(videoEdge) ? videoEdge : current.minEdgeVideo,
    },
  };
  setLibraryMeta(db, "librarySettings", JSON.stringify(next));
  return librarySettings(db);
}

export function setRating(db, filePath, rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  const result = db.prepare("UPDATE photos SET rating = ? WHERE path = ?").run(value, filePath);
  return result.changes ? value : null;
}

export function removePhotos(db, paths) {
  if (!paths.length) return;
  const stmt = db.prepare("DELETE FROM photos WHERE path = ? COLLATE NOCASE");
  db.exec("BEGIN");
  try {
    for (const filePath of paths) stmt.run(filePath);
    db.exec("COMMIT");
    dropOrphanMarks(db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ratingClause(filter, where, params) {
  const rating = Number(filter.rating);
  if (rating >= 1 && rating <= 5) {
    where.push("rating = ?");
    params.push(rating);
  }
  if (filter.kind === "photo" || filter.kind === "video") {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.origin === "camera" || filter.origin === "phone") {
    where.push("origin = ?");
    params.push(filter.origin);
  }
  if (filter.label === "person" || filter.label === "animal" || filter.label === "landscape") {
    where.push("path IN (SELECT path FROM labels WHERE label = ?)");
    params.push(filter.label);
  }
  const person = String(filter.person || "").trim();
  if (person) {
    where.push("path IN (SELECT path FROM faces WHERE name = ?)");
    params.push(person);
  }
}

export function libraryTree(db, filter = {}) {
  const where = [];
  const params = [];
  ratingClause(filter, where, params);
  return db.prepare(`SELECT year, month, day, COUNT(*) AS count FROM photos ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY year, month, day ORDER BY year DESC, month DESC, day DESC`).all(...params);
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
  ratingClause(filter, where, params);
  const text = String(filter.q || "").trim().replace(/[%_]/g, "");
  if (text) {
    where.push("name LIKE ?");
    params.push(`%${text}%`);
  }
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 80));
  const offset = Math.max(0, Number(filter.offset) || 0);
  params.push(limit, offset);
  const sql = `
    SELECT path, name, ext, dir, capture_ms AS captureMs, year, month, day, rating, kind, origin, width, height
    FROM photos
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY capture_ms DESC, path COLLATE NOCASE
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params);
}

const SCENE = new Set(["person", "animal", "landscape"]);

export function namedFaces(db) {
  return db.prepare("SELECT path, name, embedding FROM faces WHERE name != ''").all().map((row) => ({
    path: row.path,
    name: row.name,
    embedding: embeddingFromBuffer(row.embedding),
  }));
}

export function libraryPhotoPaths(db) {
  return db.prepare("SELECT path FROM photos WHERE kind = 'photo' ORDER BY capture_ms DESC").all().map((row) => row.path);
}

export function saveRecognition(db, filePath, embeddings, labels, named) {
  const cleanLabels = [...new Set((labels || []).filter((item) => SCENE.has(item)))];
  const faces = (embeddings || []).map((item) => {
    const values = Float32Array.from(item);
    return { values, name: bestName(values, named) };
  });
  if (faces.length && !cleanLabels.includes("person")) cleanLabels.push("person");
  const pool = (named || []).filter((item) => item.path !== filePath);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM faces WHERE path = ?").run(filePath);
    db.prepare("DELETE FROM labels WHERE path = ?").run(filePath);
    const insertFace = db.prepare("INSERT INTO faces (path, embedding, name) VALUES (?, ?, ?)");
    for (const face of faces) {
      insertFace.run(filePath, bufferFromEmbedding(face.values), face.name);
      if (face.name) pool.push({ path: filePath, name: face.name, embedding: face.values });
    }
    const insertLabel = db.prepare("INSERT OR IGNORE INTO labels (path, label) VALUES (?, ?)");
    for (const label of cleanLabels) insertLabel.run(filePath, label);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (named) {
    named.splice(0, named.length, ...pool);
  }
  return { faces: faces.length, labels: cleanLabels };
}

export function photoFaces(db, filePath) {
  return db.prepare("SELECT id, name FROM faces WHERE path = ? ORDER BY id").all(filePath);
}

export function libraryMarks(db) {
  const counts = Object.fromEntries(db.prepare("SELECT label, COUNT(*) AS count FROM labels GROUP BY label").all().map((row) => [row.label, row.count]));
  return {
    labels: {
      person: counts.person || 0,
      animal: counts.animal || 0,
      landscape: counts.landscape || 0,
    },
    names: db.prepare("SELECT name, COUNT(DISTINCT path) AS count FROM faces WHERE name != '' GROUP BY name ORDER BY count DESC, name COLLATE NOCASE").all(),
  };
}

export function renameFace(db, faceId, rawName) {
  const name = String(rawName || "").trim().slice(0, 40);
  const row = db.prepare("SELECT id, embedding FROM faces WHERE id = ?").get(Number(faceId));
  if (!row) return null;
  const target = { id: row.id, embedding: embeddingFromBuffer(row.embedding) };
  const faces = db.prepare("SELECT id, embedding FROM faces").all().map((item) => ({
    id: item.id,
    embedding: embeddingFromBuffer(item.embedding),
  }));
  const updates = facesToRename(target, faces, name);
  const stmt = db.prepare("UPDATE faces SET name = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const update of updates) stmt.run(update.name, update.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { name, count: updates.length };
}
