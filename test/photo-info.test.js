import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describePhoto, readPhotoFacts } from "../src/photo-info.js";
import { buildJpeg } from "./builders.js";

test("大图参数能读出拍摄时间", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-info-"));
  const file = path.join(dir, "IMG_0001.jpg");
  fs.writeFileSync(file, buildJpeg("2020:01:02 03:04:05", "12", "info"));
  const facts = readPhotoFacts(file);
  const fields = describePhoto({
    name: "IMG_0001.jpg",
    dir,
    size: 1200,
    year: 2020,
    month: 1,
    day: 2,
    rating: 3,
  }, facts);
  const time = fields.find((item) => item.label === "拍摄时间");
  assert.equal(time.value.startsWith("2020-01-02 03:04:05"), true);
  assert.equal(fields.some((item) => item.label === "星级" && item.value === "3 星"), true);
  assert.equal(fields.some((item) => item.label === "文件夹"), true);
});
