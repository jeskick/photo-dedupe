export const EXT_GROUPS = {
  dslrRaw: [
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".raf", ".orf",
    ".rw2", ".pef", ".dng", ".raw", ".rwl", ".3fr", ".fff", ".iiq", ".mrw",
    ".x3f", ".erf", ".k25", ".kdc", ".mef", ".mos", ".srw",
  ],
  dslrJpeg: [".jpg", ".jpeg", ".tif", ".tiff"],
  applePhoto: [".heic", ".heif"],
  video: [".mov", ".mp4", ".m4v", ".avi", ".mts", ".m2ts"],
};

const FAMILY_ALIAS = new Map([
  [".jpeg", ".jpg"],
  [".tiff", ".tif"],
  [".heif", ".heic"],
  [".m4v", ".mp4"],
]);

export function familyOf(ext) {
  const e = String(ext || "").toLowerCase();
  return FAMILY_ALIAS.get(e) || e;
}

export function extensionsFor(kinds) {
  const set = new Set();
  for (const [key, list] of Object.entries(EXT_GROUPS)) {
    if (kinds?.[key]) {
      for (const ext of list) set.add(ext);
    }
  }
  return set;
}

export function isVideoExt(ext) {
  return EXT_GROUPS.video.includes(String(ext || "").toLowerCase());
}

export function isRawExt(ext) {
  return EXT_GROUPS.dslrRaw.includes(String(ext || "").toLowerCase());
}

export function isRenderedStillExt(ext) {
  return EXT_GROUPS.dslrJpeg.includes(String(ext || "").toLowerCase());
}

export const SIDECAR_EXTS = [".xmp", ".aae", ".dop", ".pp3", ".on1"];
