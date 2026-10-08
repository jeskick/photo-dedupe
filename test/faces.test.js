import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bestName, bestPerson, clusterPeople, facesToRename, linkBackViews } from "../src/faces.js";
import { libraryMarks, libraryPhoto, loadPeople, openLibrary, photoFaces, purgeScan, queryPhotos, removePhotos, renameFace, saveRecognition, setRating, upsertPhotos } from "../src/library-db.js";

test("相似的脸用同一个名字，差得远的不会带上", () => {
  const named = [{ name: "小明", embedding: [1, 0, 0] }];
  assert.equal(bestPerson([0.99, 0.05, 0], [{ id: 1, name: "小明", embedding: [1, 0, 0] }]).name, "小明");
  assert.equal(bestPerson([0, 1, 0], [{ id: 1, name: "小明", embedding: [1, 0, 0] }]), null);
  assert.equal(bestName([0.99, 0.05, 0], named), "小明");
  assert.equal(bestName([0, 1, 0], named), "");
  const target = { id: 1, embedding: [1, 0, 0] };
  const faces = [target, { id: 2, embedding: [0.98, 0.02, 0] }, { id: 3, embedding: [0, 1, 0] }];
  assert.deepEqual(facesToRename(target, faces, "小明").map((item) => item.id), [1, 2]);
  assert.deepEqual(facesToRename(target, faces, "  "), [{ id: 1, name: "" }]);
});

test("差得远的脸会从已经成组的人里拆出去", () => {
  const personA = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, embedding: [1, 0, 0] }));
  const personB = Array.from({ length: 8 }, (_, index) => ({ id: index + 9, embedding: [0, 1, 0] }));
  const weak = { id: 20, embedding: [0.33, 0, Math.sqrt(1 - 0.33 * 0.33)] };
  const groups = clusterPeople([...personA, ...personB, weak]);
  assert.equal(groups.length, 3);
  const main = groups.find((group) => group.members.some((face) => face.id === 1));
  assert.equal(main.members.some((face) => face.id === 20), false);
  assert.equal(main.members.some((face) => face.id === 9), false);
});

test("同一段时间里的背影会跟着唯一的人，两个人都在时不乱标", () => {
  const shots = [
    { path: "a", captureMs: 0, personIds: [1], body: true },
    { path: "back", captureMs: 60 * 1000, personIds: [], body: true },
    { path: "later", captureMs: 10 * 60 * 60 * 1000, personIds: [], body: true },
    { path: "mix", captureMs: 20 * 60 * 60 * 1000, personIds: [], body: true },
    { path: "b", captureMs: 20 * 60 * 60 * 1000 + 1000, personIds: [2], body: true },
    { path: "a2", captureMs: 20 * 60 * 60 * 1000 + 2000, personIds: [1], body: true },
  ];
  const linked = linkBackViews(shots);
  assert.deepEqual(linked.map((item) => item.path), ["back"]);
  assert.equal(linked[0].personId, 1);
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
  assert.equal(libraryMarks(db).people.length, 1);
  assert.equal(libraryMarks(db).people[0].count, 2);
  assert.equal(queryPhotos(db, { personId: libraryMarks(db).people[0].id }).length, 2);
  const third = { ...other, path: path.join(dir, "c.jpg"), name: "c.jpg" };
  upsertPhotos(db, [third], 1);
  saveRecognition(db, third.path, [[0.97, 0.04, 0]], [], loadPeople(db));
  assert.equal(photoFaces(db, third.path)[0].name, "小明");
  const scenery = { ...photo, path: path.join(dir, "d.jpg"), name: "d.jpg" };
  upsertPhotos(db, [scenery], 1);
  saveRecognition(db, scenery.path, [], ["animal", "landscape"], []);
  assert.equal(queryPhotos(db, { label: "landscape" }).length, 1);
  assert.equal(queryPhotos(db, { label: "animal" }).length, 2);
  purgeScan(db, 9);
  assert.equal(libraryMarks(db).people.length, 0);
  assert.equal(queryPhotos(db, { label: "person" }).length, 0);
  db.close();
});

test("再次扫描保留星级和人物标记，没扫到的盘不动，扫过的盘里不见的照片会连标记一起去掉", () => {
  const seen = fs.mkdtempSync(path.join(os.tmpdir(), "photo-seen-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "photo-other-"));
  const db = openLibrary(path.join(seen, "library.sqlite"));
  const base = {
    ext: ".jpg",
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
  const kept = { ...base, path: path.join(seen, "a.jpg"), name: "a.jpg", dir: seen };
  const gone = { ...base, path: path.join(seen, "b.jpg"), name: "b.jpg", dir: seen };
  const elsewhere = { ...base, path: path.join(other, "c.jpg"), name: "c.jpg", dir: other };
  upsertPhotos(db, [kept, gone, elsewhere], 1);
  setRating(db, kept.path, 4);
  setRating(db, elsewhere.path, 2);
  const people = [];
  saveRecognition(db, kept.path, [[1, 0, 0]], ["landscape"], people);
  saveRecognition(db, gone.path, [[0, 1, 0]], ["animal"], people);
  renameFace(db, photoFaces(db, kept.path)[0].id, "小明");
  upsertPhotos(db, [kept], 2);
  const removed = purgeScan(db, 2, "photo", [seen]);
  assert.equal(removed, 1);
  assert.equal(libraryPhoto(db, kept.path).rating, 4);
  assert.equal(queryPhotos(db, { person: "小明" }).length, 1);
  assert.equal(queryPhotos(db, { label: "animal" }).length, 0);
  assert.equal(libraryPhoto(db, gone.path), null);
  assert.equal(libraryPhoto(db, elsewhere.path).rating, 2);
  assert.equal(libraryMarks(db).people.some((item) => item.name === "小明"), true);
  removePhotos(db, [kept.path]);
  assert.equal(libraryPhoto(db, kept.path), null);
  assert.equal(queryPhotos(db, { person: "小明" }).length, 0);
  assert.equal(photoFaces(db, kept.path).length, 0);
  db.close();
});
