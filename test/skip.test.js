import test from "node:test";
import assert from "node:assert/strict";
import { directoryHasProgram, isBundledAssetName, isSoftwareBoundary } from "../src/skip.js";

test("跳过系统和软件自带的目录，保留拍摄目录", () => {
  assert.equal(isSoftwareBoundary("C:\\Windows"), true);
  assert.equal(isSoftwareBoundary("C:\\Windows\\Web\\Wallpaper"), true);
  assert.equal(isSoftwareBoundary("C:\\Program Files\\Adobe"), false);
  assert.equal(isSoftwareBoundary("C:\\Program Files"), true);
  assert.equal(isSoftwareBoundary("D:\\Program Files (x86)"), true);
  assert.equal(isSoftwareBoundary("C:\\Users\\me\\AppData"), true);
  assert.equal(isSoftwareBoundary("C:\\Users\\me\\AppData\\Local\\Temp\\photo"), false);
  assert.equal(isSoftwareBoundary("D:\\Steam\\steamapps"), true);
  assert.equal(isSoftwareBoundary("C:\\Users\\Public\\Pictures\\Sample Pictures"), true);
  assert.equal(isSoftwareBoundary("D:\\Photos\\2024\\DCIM"), false);
  assert.equal(isSoftwareBoundary("C:\\Users\\me\\Documents\\WeChat Files"), false);
  assert.equal(isSoftwareBoundary("D:\\Photos\\node_modules"), true);
  assert.equal(isSoftwareBoundary("D:\\工具\\美图\\icons"), true);
  assert.equal(isSoftwareBoundary("D:\\工具\\美图\\缓存"), true);
  assert.equal(isSoftwareBoundary("D:\\Photos\\2024\\表情"), true);
  assert.equal(isSoftwareBoundary("D:\\Photos\\2024"), false);
  assert.equal(isBundledAssetName("images"), true);
  assert.equal(isBundledAssetName("DCIM"), false);
  assert.equal(directoryHasProgram(["readme.txt", "app.exe"]), true);
  assert.equal(directoryHasProgram(["IMG_0001.jpg", "IMG_0002.HEIC"]), false);
});
