import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ffmpegExecutable, renderVideoFrame } from "../src/preview.js";

test("视频预览能抽出一帧 JPEG", async (t) => {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) {
    t.skip("没有 ffmpeg");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-preview-"));
  const file = path.join(dir, "clip.mp4");
  const made = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=green:s=320x180:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    file,
  ], { windowsHide: true });
  if (made.status !== 0) {
    t.skip("ffmpeg 没能生成测试视频");
    return;
  }
  const jpeg = await renderVideoFrame(file, "1");
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.ok(jpeg.length > 100);
  const again = await renderVideoFrame(file, "1");
  assert.equal(again.length, jpeg.length);
  fs.rmSync(dir, { recursive: true, force: true });
});
