import path from "node:path";

const SKIP_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "bower_components",
  "__pycache__",
  "site-packages",
  ".venv",
  "venv",
  "__macosx",
  "windowsapps",
  "winsxs",
  "wpsystem",
  "perflogs",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
  "sample pictures",
  "sample videos",
  "示例图片",
  "示例视频",
  "steamapps",
  "epic games",
  "gog games",
  "riot games",
  "xboxgames",
  "wegameapps",
  "icons",
  "icon",
  "assets",
  "resources",
  "cache",
  "caches",
  ".cache",
  "cache2",
  "thumbnails",
  "thumbs",
  ".thumbnails",
  "emoji",
  "emojis",
  "emoticon",
  "emoticons",
  "emotion",
  "customemotion",
  "stickers",
  "sticker",
  "skins",
  "skin",
  "themes",
  "theme",
  "cursors",
  "locales",
  "locale",
  "fonts",
  "mipmap",
  "mipmaps",
  "drawable",
  "plugins",
  "plugin",
  "wallpaper",
  "wallpapers",
  "图标",
  "缓存",
  "表情",
  "表情包",
  "贴纸",
  "皮肤",
]);

const ASSET_NAMES = new Set([
  "images",
  "image",
  "img",
  "pics",
  "pictures",
  "photos",
  "res",
  "ui",
  "bitmaps",
  "bitmap",
  "textures",
  "texture",
  "samples",
  "sample",
  "demo",
  "demos",
  "help",
  "docs",
  "manual",
]);

const PROGRAM_EXTS = new Set([".exe", ".dll", ".mui", ".asar", ".ocx"]);
const PROGRAM_FILES = new Set(["package.json", "uninstall.exe"]);

const DRIVE_ROOT_NAMES = new Set([
  "windows",
  "recovery",
  "$windows.~bt",
  "$winreagent",
]);

const PHOTO_DIR_NAMES = new Set([
  "dcim",
  "camera",
  "cameras",
  "100media",
  "100apple",
  "照片",
  "相机",
  "相册",
  "wechat files",
]);

const APP_INCLUDES = [
  "photoshop",
  "lightroom",
  "premiere",
  "illustrator",
  "indesign",
  "acrobat",
  "after effects",
  "media encoder",
  "creative cloud",
];

function partsOf(fullPath) {
  return path.win32.normalize(String(fullPath || "")).split(/[\\/]/).filter(Boolean).map((part) => part.toLowerCase());
}

function pathLooksLikeInstall(parts) {
  const joined = parts.join("\\");
  if (joined.includes("\\cep\\extensions\\") || joined.includes("\\cdn-assets\\")) return true;
  return parts.some((part) => part === "adobe" || part === "cdn-assets" || part.startsWith("com.adobe.") || APP_INCLUDES.some((marker) => part.includes(marker)));
}

export function isSoftwareBoundary(fullPath) {
  const parts = partsOf(fullPath);
  const name = parts[parts.length - 1] || "";
  if (SKIP_NAMES.has(name) || pathLooksLikeInstall(parts)) return true;
  const atDriveRoot = parts.length === 2 && parts[0].endsWith(":");
  return atDriveRoot && DRIVE_ROOT_NAMES.has(name);
}

export function isPersonalPhotoDir(name) {
  return PHOTO_DIR_NAMES.has(String(name || "").toLowerCase());
}

export function directoryHasProgram(names) {
  for (const name of names) {
    const lower = String(name || "").toLowerCase();
    if (PROGRAM_FILES.has(lower)) return true;
    if (PROGRAM_EXTS.has(path.win32.extname(lower))) return true;
  }
  return false;
}

export function isBundledAssetName(name) {
  return ASSET_NAMES.has(String(name || "").toLowerCase());
}
