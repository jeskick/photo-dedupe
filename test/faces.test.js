import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bestName, facesToRename } from "../src/faces.js";
import { libraryMarks, openLibrary, photoFaces, purgeScan, queryPhotos, renameFace, saveRecognition, upsertPhotos } from "../src/library-db.js";

test("相似的脸用同一个名字，差得远的不会带上", () => {
  const named = [{ name: "小明", embedding: [1, 0, 0] }];
  assert.equal(bestName([0.99, 0.05, 0], named), "小明");
  assert.equal(bestName([0, 1, 0], named), "");
  const target = { id: 1, embedding: [1, 0, 0] };
  const faces = [target, { id: 2, embedding: [0.98, 0.02, 0] }, { id: 3, embedding: [0, 1, 0] }];
  assert.deepEqual(facesToRename(target, faces, "小明").map((item) => item.id), [1, 2]);
  assert.deepEqual(facesToRename(target, faces, "  "), [{ id: 1, name: "" }]);
});

test("标记名字后能按人和场景筛选，删照片会清掉标记", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-faces-"));
  const db = openLibrary(path.join(dir, "library.sqlite"));
  const photo = {
    path: path.join(dir, "a.jpg"),
    name: "a.jpg",
    ext: ".jpg",
    dir,
    size: 1,
    mtimeMs: 1,
    captureMs: 1,
    year: 2020,
    month: 1,
    day: 2,
    kind: "photo",
    width: 800,
    height: 600,
  };
  const other = { ...photo, path: path.join(dir, "b.jpg"), name: "b.jpg" };
  upsertPhotos(db, [photo, other], 1);
  const named = [];
  saveRecognition(db, photo.path, [[1, 0, 0]], ["landscape"], named);
  saveRecognition(db, other.path, [[0.99, 0.01, 0]], ["animal"], named);
  assert.equal(queryPhotos(db, { label: "person" }).length, 2);
  assert.equal(queryPhotos(db, { label: "animal" }).length, 1);
  const face = photoFaces(db, photo.path)[0];
  const renamed = renameFace(db, face.id, "小明");
  assert.equal(renamed.count, 2);
  assert.equal(queryPhotos(db, { person: "小明" }).length, 2);
  assert.equal(libraryMarks(db).names[0].name, "小明");
  purgeScan(db, 9);
  assert.equal(libraryMarks(db).names.length, 0);
  assert.equal(queryPhotos(db, { label: "person" }).length, 0);
  db.close();
});
