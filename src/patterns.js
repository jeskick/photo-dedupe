import path from "node:path";

function literalCount(text) {
  return text.replace(/[*.]/g, "").length;
}

/** 把「*.pdf」「*kk*.pdf」收成最多 20 条。* 表示任意文字，匹配整个文件名。 */
export function compileNamePatterns(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,，;；]+/);
  const patterns = [];
  for (const piece of raw) {
    const text = String(piece || "").trim();
    if (!text) continue;
    if (text.length > 80) {
      const error = new Error("文件名条件太长");
      error.status = 400;
      throw error;
    }
    if (patterns.length >= 20) {
      const error = new Error("文件名条件最多 20 条");
      error.status = 400;
      throw error;
    }
    if (literalCount(text) < 2) {
      const error = new Error("文件名条件请写得更具体，例如 *.pdf 或 *kk*.pdf");
      error.status = 400;
      throw error;
    }
    const source = `^${text.split("*").map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&")).join(".*")}$`;
    patterns.push({ text, re: new RegExp(source, "i") });
  }
  return {
    list: patterns.map((item) => item.text),
    match(name) {
      if (!patterns.length) return false;
      const base = path.win32.basename(String(name || ""));
      return patterns.some((item) => item.re.test(base));
    },
  };
}
