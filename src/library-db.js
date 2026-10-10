import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bestPerson, bufferFromEmbedding, clusterPeople, embeddingFromBuffer, FACE_MODEL, linkBackViews, mainSubjects } from "./faces.js";

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
      name TEXT NOT NULL DEFAULT '',
      person_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS faces_path ON faces(path);
    CREATE INDEX IF NOT EXISTS faces_name ON faces(name);
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      exemplar BLOB
    );
    CREATE TABLE IF NOT EXISTS appearances (
      path TEXT NOT NULL,
      person_id INTEGER NOT NULL,
      PRIMARY KEY (path, person_id)
    );
    CREATE TABLE IF NOT EXISTS labels (
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (path, label)
    );
  `);
  const faceColumns = db.prepare("PRAGMA table_info(faces)").all();
  if (faceColumns.length && !faceColumns.some((column) => column.name === "person_id")) {
    db.exec("ALTER TABLE faces ADD COLUMN person_id INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id)");
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
  db.exec("DELETE FROM appearances WHERE path NOT IN (SELECT path FROM photos)");
  db.exec("DELETE FROM people WHERE name = '' AND id NOT IN (SELECT person_id FROM faces) AND id NOT IN (SELECT person_id FROM appearances)");
}

function scannedRoots(roots) {
  return (roots || []).map((root) => path.resolve(String(root || "")).replace(/[\\/]+$/, "").toLowerCase()).filter(Boolean);
}

function underScannedRoot(filePath, roots) {
  const full = path.resolve(String(filePath || "")).toLowerCase();
  return roots.some((root) => full === root || full.startsWith(`${root}\\`) || full.startsWith(`${root}/`));
}

export function purgeScan(db, scanId, kind = "photo", roots) {
  const media = kind === "video" ? "video" : "photo";
  const limit = scannedRoots(roots);
  db.exec("BEGIN");
  try {
    const stale = db.prepare("SELECT path FROM photos WHERE kind = ? AND scan_id != ?").all(media, scanId);
    const remove = db.prepare("DELETE FROM photos WHERE path = ?");
    let changes = 0;
    for (const row of stale) {
      if (limit.length && !underScannedRoot(row.path, limit)) continue;
      remove.run(row.path);
      changes += 1;
    }
    if (changes) dropOrphanMarks(db);
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

export function libraryKindTotals(db) {
  const totals = { photo: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 } };
  const rows = db.prepare("SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM photos GROUP BY kind").all();
  for (const row of rows) {
    if (!totals[row.kind]) continue;
    totals[row.kind] = { count: Number(row.count) || 0, bytes: Number(row.bytes) || 0 };
  }
  return totals;
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
    dropOrphanMarks(db);
    db.exec("COMMIT");
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
    where.push(`path IN (
      SELECT path FROM faces WHERE name = ?
      UNION
      SELECT appearances.path FROM appearances JOIN people ON people.id = appearances.person_id WHERE people.name = ?
    )`);
    params.push(person, person);
  }
  const personId = Number(filter.personId);
  const personIds = String(filter.personIds || "")
    .split(",")
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
    .slice(0, 1000);
  if (personId > 0) {
    where.push(`path IN (
      SELECT path FROM faces WHERE person_id = ?
      UNION
      SELECT path FROM appearances WHERE person_id = ?
    )`);
    params.push(personId, personId);
  } else if (personIds.length) {
    const marks = personIds.map(() => "?").join(", ");
    where.push(`path IN (
      SELECT path FROM faces WHERE person_id IN (${marks})
      UNION
      SELECT path FROM appearances WHERE person_id IN (${marks})
    )`);
    params.push(...personIds, ...personIds);
  }
}

export function libraryTree(db, filter = {}) {
  const where = [];
  const params = [];
  ratingClause(filter, where, params);
  return db.prepare(`SELECT year, month, day, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM photos ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY year, month, day ORDER BY year DESC, month DESC, day DESC`).all(...params);
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
    SELECT path, name, ext, dir, size, capture_ms AS captureMs, year, month, day, rating, kind, origin, width, height
    FROM photos
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY capture_ms DESC, path COLLATE NOCASE
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params);
}

const SCENE = new Set(["person", "animal", "landscape"]);

export function loadPeople(db) {
  return db.prepare("SELECT id, name, exemplar FROM people WHERE exemplar IS NOT NULL").all().map((row) => ({
    id: Number(row.id),
    name: row.name || "",
    embedding: embeddingFromBuffer(row.exemplar),
  }));
}

export function libraryPhotoPaths(db) {
  return db.prepare("SELECT path FROM photos WHERE kind = 'photo' ORDER BY capture_ms DESC").all().map((row) => row.path);
}

export function fileIsGone(filePath) {
  try {
    fs.statSync(filePath);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  const root = path.parse(filePath).root;
  if (!root) return false;
  try {
    fs.statSync(root);
    return true;
  } catch {
    return false;
  }
}

export function forgetMissingPhotos(db, paths) {
  const removed = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const photo = libraryPhoto(db, path.resolve(String(raw || "")));
    if (!photo || seen.has(photo.path.toLowerCase())) continue;
    seen.add(photo.path.toLowerCase());
    if (!fileIsGone(photo.path)) continue;
    removed.push(photo.path);
  }
  if (removed.length) removePhotos(db, removed);
  return removed;
}

function faceInput(item) {
  if (Array.isArray(item)) return { embedding: Float32Array.from(item), area: 0 };
  if (!Array.isArray(item?.embedding)) return null;
  return { embedding: Float32Array.from(item.embedding), area: Number(item.area) || 0 };
}

export function saveRecognition(db, filePath, embeddings, labels, people = []) {
  const cleanLabels = [...new Set((labels || []).filter((item) => SCENE.has(item)))];
  const faces = mainSubjects((embeddings || []).map(faceInput).filter(Boolean)).map((face) => {
    const values = face.embedding;
    const known = bestPerson(values, people);
    if (known) return { values, personId: known.id, name: known.name || "" };
    return { values, personId: 0, name: "" };
  });
  if (faces.length && !cleanLabels.includes("person")) cleanLabels.push("person");
  if (cleanLabels.includes("person") && cleanLabels.includes("landscape")) {
    cleanLabels.splice(cleanLabels.indexOf("landscape"), 1);
  }
  const added = [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM faces WHERE path = ?").run(filePath);
    db.prepare("DELETE FROM labels WHERE path = ?").run(filePath);
    const insertPerson = db.prepare("INSERT INTO people (name, exemplar) VALUES ('', ?)");
    const insertFace = db.prepare("INSERT INTO faces (path, embedding, name, person_id) VALUES (?, ?, ?, ?)");
    const insertAppearance = db.prepare("INSERT OR IGNORE INTO appearances (path, person_id) VALUES (?, ?)");
    db.prepare("DELETE FROM appearances WHERE path = ?").run(filePath);
    for (const face of faces) {
      if (!face.personId) {
        face.personId = Number(insertPerson.run(bufferFromEmbedding(face.values)).lastInsertRowid);
        const created = { id: face.personId, name: "", embedding: face.values };
        people.push(created);
        added.push(created);
      }
      insertFace.run(filePath, bufferFromEmbedding(face.values), face.name, face.personId);
      insertAppearance.run(filePath, face.personId);
    }
    const insertLabel = db.prepare("INSERT OR IGNORE INTO labels (path, label) VALUES (?, ?)");
    for (const label of cleanLabels) insertLabel.run(filePath, label);
    db.exec("DELETE FROM people WHERE name = '' AND id NOT IN (SELECT person_id FROM faces) AND id NOT IN (SELECT person_id FROM appearances)");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    for (const created of added) {
      const index = people.indexOf(created);
      if (index >= 0) people.splice(index, 1);
    }
    throw error;
  }
  const alive = new Set(db.prepare("SELECT id FROM people").all().map((row) => Number(row.id)));
  for (let index = people.length - 1; index >= 0; index -= 1) {
    if (!alive.has(people[index].id)) people.splice(index, 1);
  }
  return { faces: faces.length, labels: cleanLabels };
}

export function photoFaces(db, filePath) {
  return db.prepare("SELECT id, name FROM faces WHERE path = ? ORDER BY id").all(filePath);
}

export function attachLooseFaces(db) {
  const loose = db.prepare("SELECT id, embedding, name FROM faces WHERE person_id = 0").all();
  if (!loose.length) return 0;
  const people = loadPeople(db);
  const update = db.prepare("UPDATE faces SET person_id = ?, name = ? WHERE id = ?");
  const insert = db.prepare("INSERT INTO people (name, exemplar) VALUES (?, ?)");
  db.exec("BEGIN");
  try {
    for (const row of loose) {
      const embedding = embeddingFromBuffer(row.embedding);
      const known = bestPerson(embedding, people);
      const name = known?.name || row.name || "";
      let personId = known?.id || 0;
      if (!personId) {
        personId = Number(insert.run(name, bufferFromEmbedding(embedding)).lastInsertRowid);
        people.push({ id: personId, name, embedding });
      }
      update.run(personId, name, row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return loose.length;
}

const PEOPLE_CLUSTER = "4";

export function prepareRecognition(db) {
  if (libraryMeta(db).faceModel === FACE_MODEL) return false;
  db.exec("DELETE FROM faces");
  db.exec("DELETE FROM people");
  db.exec("DELETE FROM labels");
  db.exec("DELETE FROM appearances");
  setLibraryMeta(db, "faceModel", FACE_MODEL);
  setLibraryMeta(db, "peopleCluster", "");
  return true;
}

function applyBackViews(db) {
  const rows = db.prepare(`
    SELECT photos.path AS path, photos.capture_ms AS captureMs, faces.person_id AS personId,
      CASE WHEN labels.path IS NULL THEN 0 ELSE 1 END AS body
    FROM photos
    LEFT JOIN faces ON faces.path = photos.path
    LEFT JOIN labels ON labels.path = photos.path AND labels.label = 'person'
    WHERE photos.kind = 'photo'
  `).all();
  const shots = new Map();
  for (const row of rows) {
    const shot = shots.get(row.path) || { path: row.path, captureMs: row.captureMs, personIds: [], body: false };
    if (row.personId) shot.personIds.push(row.personId);
    if (row.body) shot.body = true;
    shots.set(row.path, shot);
  }
  const linked = linkBackViews([...shots.values()]);
  const insert = db.prepare("INSERT OR IGNORE INTO appearances (path, person_id) VALUES (?, ?)");
  const label = db.prepare("INSERT OR IGNORE INTO labels (path, label) VALUES (?, 'person')");
  for (const item of linked) {
    insert.run(item.path, item.personId);
    label.run(item.path);
  }
  return linked.length;
}

export function relinkBackViews(db) {
  db.exec("BEGIN");
  try {
    db.exec(`DELETE FROM appearances WHERE NOT EXISTS (
      SELECT 1 FROM faces
      WHERE faces.path = appearances.path AND faces.person_id = appearances.person_id
    )`);
    const linked = applyBackViews(db);
    db.exec("COMMIT");
    return linked;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function rebuildPeople(db) {
  const faces = db.prepare("SELECT id, path, name, embedding FROM faces").all().map((row) => ({
    id: row.id,
    path: row.path,
    name: row.name || "",
    embedding: embeddingFromBuffer(row.embedding),
  }));
  const groups = clusterPeople(faces);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM people");
    db.exec("DELETE FROM appearances");
    const insert = db.prepare("INSERT INTO people (name, exemplar) VALUES (?, ?)");
    const update = db.prepare("UPDATE faces SET person_id = ?, name = ? WHERE id = ?");
    const appear = db.prepare("INSERT OR IGNORE INTO appearances (path, person_id) VALUES (?, ?)");
    for (const group of groups) {
      const counts = new Map();
      for (const face of group.members) {
        if (face.name) counts.set(face.name, (counts.get(face.name) || 0) + 1);
      }
      let name = "";
      let best = 0;
      for (const [value, count] of counts) {
        if (count > best) {
          best = count;
          name = value;
        }
      }
      const personId = Number(insert.run(name, bufferFromEmbedding(group.center)).lastInsertRowid);
      for (const face of group.members) {
        update.run(personId, name, face.id);
        appear.run(face.path, personId);
      }
    }
    applyBackViews(db);
    setLibraryMeta(db, "peopleCluster", PEOPLE_CLUSTER);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return groups.length;
}

export function ensurePeopleClusters(db, force = false) {
  if (!force && libraryMeta(db).peopleCluster === PEOPLE_CLUSTER) return 0;
  return rebuildPeople(db);
}

export function libraryMarks(db) {
  ensurePeopleClusters(db);
  attachLooseFaces(db);
  const counts = Object.fromEntries(db.prepare("SELECT label, COUNT(*) AS count FROM labels GROUP BY label").all().map((row) => [row.label, row.count]));
  return {
    labels: {
      person: counts.person || 0,
      animal: counts.animal || 0,
      landscape: counts.landscape || 0,
    },
    people: db.prepare(`
      SELECT people.id AS id, people.name AS name, COUNT(DISTINCT seen.path) AS count
      FROM people JOIN (
        SELECT person_id, path FROM faces
        UNION
        SELECT person_id, path FROM appearances
      ) AS seen ON seen.person_id = people.id
      GROUP BY people.id
      ORDER BY count DESC, people.id
    `).all(),
  };
}

export function renamePerson(db, personId, rawName) {
  const name = String(rawName || "").trim().slice(0, 40);
  const row = db.prepare("SELECT id FROM people WHERE id = ?").get(Number(personId));
  if (!row) return null;
  db.prepare("UPDATE people SET name = ? WHERE id = ?").run(name, row.id);
  const count = db.prepare("UPDATE faces SET name = ? WHERE person_id = ?").run(name, row.id).changes || 0;
  return { name, count, personId: row.id };
}

export function renameFace(db, faceId, rawName) {
  const row = db.prepare("SELECT person_id AS personId FROM faces WHERE id = ?").get(Number(faceId));
  if (!row?.personId) return null;
  return renamePerson(db, row.personId, rawName);
}
