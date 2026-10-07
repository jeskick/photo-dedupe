const COPY_SUFFIX =
  /(?:\s*[\(（]\d+[\)）]|\s*[-–—]\s*(?:副本|复件|copy)(?:\s*[\(（]\d+[\)）])?|\s+copy(?:\s*\d+)?)$/i;

export function stemOf(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

export function exactKey(filename) {
  return stemOf(filename).toLocaleLowerCase("en-US");
}

/** 去掉 Windows / 资源管理器产生的“副本”“(1)”“copy”后缀，便于认出同一次拍摄的复制件。 */
export function normalizeKey(filename) {
  let stem = stemOf(filename);
  let prev = "";
  while (stem && stem !== prev) {
    prev = stem;
    const next = stem.replace(COPY_SUFFIX, "").trim();
    if (!next) break;
    stem = next;
  }
  return stem.toLocaleLowerCase("en-US");
}
