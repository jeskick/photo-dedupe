import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogFiles, classifyOrigin, isExcludedDir, parseDriveList, passesMinEdge, utcParts } from "../src/library-scan.js";
import { libraryCount, libraryPhoto, librarySettings, libraryTree, openLibrary, purgeScan, queryPhotos, saveLibrarySettings, setRating, upsertPhotos } from "../src/library-db.js";
import { pairedCameraPaths } from "../src/library-scan.js";
import { buildJpeg } from "./builders.js";

test("磁盘列表只保留盘符", () => {
  assert.deepEqual(parseDriveList("C:\r\nD:\r\n\r\nnot-a-drive\r\n"), ["C:\\", "D:\\"]);
});

test("拍摄日期按相机上的年月日分组", () => {
  assert.deepEqual(utcParts(Date.UTC(2020, 0, 2, 3, 4, 5)), { year: 2020, month: 1, day: 2 });
});

test("照片库按时间保存，混有其他文件的目录不进入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-library-"));
  const dbPath = path.join(dir, "library.sqlite");
  const photo = buildJpeg("2020:01:02 03:04:05", "12", "library-photo");
  fs.mkdirSync(path.join(dir, "相册"));
  fs.writeFileSync(path.join(dir, "相册", "IMG_0001.jpg"), photo);
  fs.writeFileSync(path.join(dir, "相册", "IMG_0001 (1).jpg"), photo);
  fs.mkdirSync(path.join(dir, "文档", "内层"), { recursive: true });
  fs.writeFileSync(path.join(dir, "文档", "notes.txt"), "hello");
  fs.writeFileSync(path.join(dir, "文档", "内层", "skip.jpg"), photo);
  const found = [];
  const result = catalogFiles([dir], { onFile: (file) => found.push(file) });
  assert.equal(result.files, 2);
  assert.equal(found.every((file) => file.year === 2020 && file.month === 1 && file.day === 2), true);
  assert.equal(found.some((file) => file.path.includes("skip.jpg")), false);

  const db = openLibrary(dbPath);
  upsertPhotos(db, found, 1);
  upsertPhotos(db, found.map((file) => ({ ...file, name: "kept.jpg" })), 2);
  assert.equal(libraryCount(db), 2);
  purgeScan(db, 2);
  assert.equal(libraryCount(db), 2);
  const tree = libraryTree(db);
  assert.equal(tree[0].count, 2);
  const listed = queryPhotos(db, { year: 2020, month: 1, q: "kept" });
  assert.equal(listed.length, 2);
  const kept = listed[0];
  setRating(db, kept.path, 4);
  upsertPhotos(db, found.map((file) => ({ ...file, name: "kept.jpg" })), 3);
  assert.equal(libraryPhoto(db, kept.path).rating, 4);
  assert.equal(queryPhotos(db, { rating: 4 }).length, 1);
  assert.equal(queryPhotos(db, { rating: 5 }).length, 0);
  assert.equal(libraryTree(db, { rating: 4 })[0].count, 1);
  db.close();
});

test("同目录同名的 CR2 和 JPG 会一起列出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-pair-"));
  const jpg = path.join(dir, "IMG_0001.JPG");
  const cr2 = path.join(dir, "IMG_0001.CR2");
  fs.writeFileSync(jpg, "a");
  fs.writeFileSync(cr2, "b");
  fs.writeFileSync(path.join(dir, "IMG_0001.xmp"), "c");
  fs.writeFileSync(path.join(dir, "other.jpg"), "d");
  const paired = pairedCameraPaths(jpg).map((item) => path.basename(item).toLowerCase()).sort();
  assert.deepEqual(paired, ["img_0001.cr2", "img_0001.jpg"]);
  assert.deepEqual(pairedCameraPaths(path.join(dir, "other.jpg")).map((item) => path.basename(item)), ["other.jpg"]);
});

test("区分相机和手机，排除目录不会误伤相邻文件夹", () => {
  assert.equal(classifyOrigin(".CR2", ""), "camera");
  assert.equal(classifyOrigin(".jpg", "Apple iPhone 14"), "phone");
  assert.equal(classifyOrigin(".jpg", "Canon EOS R5"), "camera");
  assert.equal(classifyOrigin(".heic", ""), "phone");
  assert.equal(classifyOrigin(".mts", ""), "camera");
  assert.equal(classifyOrigin(".jpg", ""), "");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photo-exclude-"));
  const sibling = `${root}-other`;
  fs.mkdirSync(path.join(root, "child"), { recursive: true });
  fs.mkdirSync(sibling);
  assert.equal(isExcludedDir(path.join(root, "child"), [root]), true);
  assert.equal(isExcludedDir(sibling, [root]), false);
  assert.equal(passesMinEdge(640, 480, 800), false);
  assert.equal(passesMinEdge(1920, 1080, 800), true);
  assert.equal(passesMinEdge(0, 0, 2000), true);

  const db = openLibrary(path.join(root, "library.sqlite"));
  const saved = saveLibrarySettings(db, { excludeDirs: [root], minEdgePhoto: 1200, minEdgeVideo: 480 });
  assert.equal(saved.minEdgePhoto, 1200);
  assert.equal(saved.minEdgeVideo, 480);
  assert.equal(saved.excludeDirs[0].toLowerCase(), path.resolve(root).toLowerCase());
  assert.deepEqual(librarySettings(db).excludeDirs, saved.excludeDirs);
  const base = { size: 10, mtimeMs: 1, captureMs: 1, year: 2024, month: 1, day: 2, width: 100, height: 100 };
  upsertPhotos(db, [
    { ...base, path: path.join(root, "a.jpg"), name: "a.jpg", ext: ".jpg", dir: root, kind: "photo", origin: "camera" },
    { ...base, path: path.join(root, "b.mp4"), name: "b.mp4", ext: ".mp4", dir: root, kind: "video", origin: "phone" },
  ], 1);
  assert.equal(queryPhotos(db, { kind: "video" }).length, 1);
  assert.equal(queryPhotos(db, { kind: "photo", origin: "camera" }).length, 1);
  assert.equal(queryPhotos(db, { kind: "photo", origin: "phone" }).length, 0);
  assert.equal(libraryCount(db, "video"), 1);
  db.close();
});
