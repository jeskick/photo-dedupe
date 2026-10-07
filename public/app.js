const STORE = "photo-dedupe-settings";

const rootsEl = document.querySelector("#roots");
const rootNote = document.querySelector("#root-note");
const statusEl = document.querySelector("#status");
const totalsEl = document.querySelector("#totals");
const resultsEl = document.querySelector("#results");
const modal = document.querySelector("#modal");
const modalText = document.querySelector("#modal-text");

const state = {
  roots: [],
  groups: [],
  jobId: "",
  running: false,
  source: null,
  queue: Promise.resolve(),
  filter: "all",
  expandAll: false,
};

function h(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked" || key === "disabled") node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children || []) if (child) node.append(child);
  return node;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatCapture(ms, subsecKnown) {
  if (ms == null) return "无拍摄时间";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return subsecKnown ? `${text}.${String(date.getUTCMilliseconds()).padStart(3, "0")}` : text;
}

function setStatus(text, warn) {
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", Boolean(warn));
}

function save() {
  const settings = {
    roots: state.roots,
    kinds: currentKinds(),
    nameMode: document.querySelector("input[name=name-mode]:checked")?.value || "normalized",
    tolerance: document.querySelector("#tolerance").value,
    withoutTime: document.querySelector("#without-time").checked,
    similar: document.querySelector("#similar").checked,
    similarDistance: document.querySelector("#similar-distance").value,
    sidecars: document.querySelector("#sidecars").checked,
  };
  localStorage.setItem(STORE, JSON.stringify(settings));
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}

function currentKinds() {
  return {
    dslrRaw: document.querySelector("#kind-raw").checked,
    dslrJpeg: document.querySelector("#kind-jpeg").checked,
    applePhoto: document.querySelector("#kind-apple").checked,
    video: document.querySelector("#kind-video").checked,
  };
}

function renderRoots() {
  rootsEl.replaceChildren();
  if (!state.roots.length) {
    rootsEl.append(h("p", { class: "note", text: "还没有目录。" }));
  }
  for (const root of state.roots) {
    const button = h("button", { type: "button", class: "ghost", text: "移除" });
    button.addEventListener("click", () => {
      state.roots = state.roots.filter((item) => item !== root);
      renderRoots();
      save();
    });
    rootsEl.append(h("div", { class: "root" }, [h("span", { text: root }), button]));
  }
  const drives = state.roots.filter((item) => /^[a-zA-Z]:\\?$/.test(item.trim()));
  rootNote.hidden = !drives.length;
  rootNote.textContent = drives.length ? `整盘 ${drives.join("、")}，扫描较久。` : "";
}

function addRoots(paths) {
  for (const raw of paths) {
    const text = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
    if (!text) continue;
    if (state.roots.some((item) => item.toLowerCase() === text.toLowerCase())) continue;
    state.roots.push(text);
  }
  renderRoots();
  save();
}

function totals() {
  let deleteCount = 0;
  let wasted = 0;
  let activeGroups = 0;
  for (const group of state.groups) {
    if (!group.enabled) continue;
    activeGroups += 1;
    for (const file of group.files) {
      if (file.role === "delete") {
        deleteCount += 1;
        wasted += file.size;
      }
    }
  }
  return { deleteCount, wasted, activeGroups, groups: state.groups.length };
}

function passesFilter(group) {
  if (state.filter === "exact") return group.kind !== "similar";
  if (state.filter === "similar") return group.kind === "similar";
  return true;
}

function outcome(file) {
  if (file.role === "keep") return { className: "keep", text: "留下" };
  if (file.role === "spare") return { className: "spare", text: "也留下" };
  return { className: "drop", text: "将删除" };
}

function updateTotals() {
  const stat = totals();
  const exact = state.groups.filter((group) => group.kind !== "similar").length;
  const similar = state.groups.length - exact;
  document.querySelector('[data-filter="all"]').textContent = `全部 ${state.groups.length}`;
  document.querySelector('[data-filter="exact"]').textContent = `内容相同 ${exact}`;
  document.querySelector('[data-filter="similar"]').textContent = `画面相似 ${similar}`;
  if (!state.jobId) {
    totalsEl.textContent = "尚未扫描";
  } else if (!stat.groups) {
    totalsEl.textContent = "没有重复组";
  } else {
    totalsEl.textContent = `${stat.groups} 组 · 将删除 ${stat.deleteCount} 个 · 可释放 ${formatBytes(stat.wasted)}`;
  }
  const idle = !state.running && state.jobId;
  document.querySelector("#delete").disabled = !idle || stat.deleteCount === 0;
  document.querySelector("#export").disabled = !state.jobId || state.running;
  document.querySelector("#toggle-open").disabled = !state.groups.length;
  document.querySelector("#toggle-open").textContent = state.expandAll ? "全部收起" : "全部展开";
  document.querySelector("#legend").hidden = !state.groups.length;
  for (const button of document.querySelectorAll("#filters .chip")) {
    button.classList.toggle("on", button.dataset.filter === state.filter);
  }
}

function setBusy(running) {
  state.running = running;
  document.querySelector("#scan").disabled = running;
  document.querySelector("#pick-multi").disabled = running;
  document.querySelector("#pick-one").disabled = running;
  document.querySelector("#stop").disabled = !running;
  updateTotals();
}

function renderGroup(group) {
  const waste = group.files.filter((file) => file.role === "delete").reduce((sum, file) => sum + file.size, 0);
  const dropCount = group.files.filter((file) => file.role === "delete").length;
  const keeper = group.files.find((file) => file.role === "keep");
  group.wasted = waste;
  const enable = h("input", { type: "checkbox", class: "group-enable", checked: group.enabled !== false });
  enable.dataset.role = "enable";
  const title = group.kind === "similar" ? `${group.files.length} 个画面相似` : `${group.files.length} 个内容相同`;
  const openButton = h("button", { type: "button", class: "ghost compact", text: group.open ? "收起" : "展开", title: "选择留下哪一份" });
  openButton.dataset.action = "toggle";
  const previewButton = h("button", { type: "button", class: "ghost compact", text: group.showPreview ? "关预览" : "预览", title: "对比预览" });
  previewButton.dataset.action = "preview-group";
  const summary = [
    keeper ? `留下 ${keeper.name}` : "还没有留下的文件",
    `删除 ${dropCount} 个`,
    formatCapture(group.captureMs, group.subsecKnown),
    group.kind === "similar" ? `画面差异 ${group.distance ?? 0}` : "内容一致",
    `可释放 ${formatBytes(waste)}`,
  ].join(" · ");
  const header = h("header", {}, [
    h("label", { class: "check slim" }, [enable, document.createTextNode("清理")]),
    h("div", { class: "head-text" }, [
      h("h3", { text: title }),
      h("span", { class: "meta", text: summary, title: summary }),
    ]),
    h("div", { class: "head-actions" }, [previewButton, openButton]),
  ]);
  const classes = ["group"];
  if (group.kind === "similar") classes.push("similar");
  if (group.enabled === false) classes.push("off");
  const card = h("article", { class: classes.join(" "), id: `group-${group.id}` }, [header]);
  card.dataset.id = group.id;
  if (!group.open) return card;
  if (group.showPreview) {
    card.append(renderCards(group));
    return card;
  }
  for (const file of group.files) card.append(renderFileRow(group, file));
  return card;
}

function folderOf(filePath) {
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts[parts.length - 1] || filePath;
}

function choiceControls(group, file) {
  const radio = h("input", { type: "radio", name: `keep-${group.id}`, checked: file.role === "keep" });
  radio.dataset.role = "keep";
  radio.dataset.path = file.path;
  const drop = h("input", { type: "checkbox", checked: file.role === "delete" });
  drop.dataset.role = "drop";
  drop.dataset.path = file.path;
  drop.disabled = file.role === "keep";
  return h("div", { class: "choice" }, [
    h("label", { class: "pick" }, [radio, document.createTextNode("留下")]),
    h("label", { class: "pick" }, [drop, document.createTextNode("删除")]),
  ]);
}

function revealButton(file) {
  const reveal = h("button", { type: "button", class: "ghost compact", text: "位置", title: "打开位置" });
  reveal.dataset.action = "reveal";
  reveal.dataset.path = file.path;
  return reveal;
}

function renderFileRow(group, file) {
  const distance = file.role !== "keep" && file.distance != null ? `差异 ${file.distance}` : "";
  const folder = h("span", { class: "folder", text: folderOf(file.path), title: file.path });
  const name = h("span", { class: "name", text: file.name, title: file.path });
  return h("div", { class: `file ${file.role}`, title: file.path }, [
    choiceControls(group, file),
    folder,
    name,
    h("span", { class: "size", text: formatBytes(file.size) }),
    distance ? h("span", { class: "distance", text: distance }) : null,
    revealButton(file),
  ]);
}

function renderCards(group) {
  const box = h("div", { class: "cards" });
  for (const file of group.files) {
    const mark = outcome(file);
    const distance = file.role !== "keep" && file.distance != null ? `差异 ${file.distance}` : "";
    const failed = h("p", { class: "preview-miss", text: "这张预览打不开" });
    let media;
    if (VIDEO_EXT.has(file.ext)) {
      media = document.createElement("video");
      media.controls = true;
      media.preload = "metadata";
      media.src = `/api/jobs/${state.jobId}/raw?path=${encodeURIComponent(file.path)}`;
      media.addEventListener("error", () => media.replaceWith(failed));
    } else {
      media = h("img", { alt: file.name });
      media.addEventListener("error", () => media.replaceWith(failed));
      media.src = `/api/jobs/${state.jobId}/preview?path=${encodeURIComponent(file.path)}`;
    }
    box.append(h("div", { class: `shot ${file.role}` }, [
      media,
      h("div", { class: "folder", text: folderOf(file.path) }),
      h("div", { class: "name-line" }, [
        h("span", { class: `tag ${mark.className}`, text: mark.text }),
        h("span", { class: "name", text: `${file.name} · ${formatBytes(file.size)}` }),
      ]),
      distance ? h("div", { class: "meta-line", text: distance }) : null,
      h("div", { class: "path", text: file.path }),
      h("div", { class: "tools" }, [choiceControls(group, file), revealButton(file)]),
    ]));
  }
  return box;
}

const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".avi", ".mts", ".m2ts"]);

function visibleGroups() {
  return state.groups.filter(passesFilter).sort((a, b) => b.wasted - a.wasted);
}

function renderAll() {
  resultsEl.replaceChildren();
  const visible = visibleGroups();
  if (!state.groups.length) {
    resultsEl.append(h("p", { class: "empty", text: state.jobId && !state.running ? "没有找到重复文件。" : "重复项会按组列在这里。每组默认留下一份，其余标为删除。" }));
  } else if (!visible.length) {
    resultsEl.append(h("p", { class: "empty", text: "这个分类里没有重复组。" }));
  } else {
    for (const group of visible) resultsEl.append(renderGroup(group));
  }
  updateTotals();
}

function upsertGroup(group) {
  const index = state.groups.findIndex((item) => item.id === group.id);
  const previous = index >= 0 ? state.groups[index] : null;
  if (previous) {
    group.open = previous.open;
    group.showPreview = previous.showPreview;
  } else group.open = state.expandAll;
  if (index >= 0) state.groups[index] = group;
  else state.groups.push(group);
  const existing = document.getElementById(`group-${group.id}`);
  if (!passesFilter(group)) {
    existing?.remove();
    updateTotals();
    return;
  }
  const card = renderGroup(group);
  if (existing) existing.replaceWith(card);
  else {
    if (resultsEl.querySelector(".empty")) resultsEl.replaceChildren();
    resultsEl.append(card);
  }
  updateTotals();
}

function enqueue(task) {
  state.queue = state.queue.then(task, task);
  return state.queue;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function listen(jobId) {
  state.source?.close();
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.source = source;
  source.addEventListener("progress", (event) => {
    const progress = JSON.parse(event.data);
    const bits = [progress.phase || "扫描中"];
    if (progress.dirs) bits.push(`已查看 ${progress.dirs} 个文件夹`);
    if (progress.files != null) bits.push(`照片/视频 ${progress.files} 个`);
    if (progress.candidates) bits.push(`同名同大小 ${progress.candidates} 个`);
    if (progress.metaTotal) bits.push(`拍摄时间 ${progress.metaDone || 0}/${progress.metaTotal}`);
    if (progress.hashTotal) bits.push(`内容校验 ${progress.hashDone || 0}/${progress.hashTotal}`);
    setStatus(bits.join(" · "));
  });
  source.addEventListener("group", (event) => upsertGroup(JSON.parse(event.data)));
  source.addEventListener("done", (event) => finishScan(JSON.parse(event.data), false));
  source.addEventListener("cancelled", () => finishScan({ cancelled: true }, false));
  source.addEventListener("failed", (event) => {
    const data = JSON.parse(event.data);
    finishScan(null, data.error || "扫描失败");
  });
}

function finishScan(summary, error) {
  state.source?.close();
  state.source = null;
  setBusy(false);
  if (error) {
    setStatus(error, true);
    renderAll();
    return;
  }
  if (summary?.cancelled) {
    setStatus(`已停止。已确认 ${state.groups.length} 组重复，可以处理这些结果。`);
  } else if (summary) {
    const seconds = Math.max(1, Math.round((summary.elapsedMs || 0) / 1000));
    const parts = [`扫描完成，用时 ${seconds} 秒。检查 ${summary.filesScanned} 个文件，确认 ${summary.groups} 组重复。`];
    if (summary.candidates != null) parts.push(`其中 ${summary.candidates} 个文件大小和文件名相同，只读取了这些文件的拍摄信息。`);
    if (summary.hardlinksSkipped) parts.push(`跳过硬链接 ${summary.hardlinksSkipped} 个。`);
    if (summary.softwareSkipped) parts.push(`已跳过 ${summary.softwareSkipped} 个软件目录，其中的图标和缓存图片不参与查重。`);
    if (summary.nestedRoots?.length) parts.push(`已跳过位于其他所选目录内的 ${summary.nestedRoots.length} 个文件夹。`);
    if (summary.invalidRoots?.length) parts.push(`无法打开：${summary.invalidRoots.join("、")}`);
    if (summary.errors?.length) parts.push(`${summary.errors.length} 个路径读取失败。`);
    if (summary.similarError) parts.push(summary.similarError);
    if (!summary.groups) parts.push("没有找到内容一致的重复文件。");
    setStatus(parts.join(" "));
  }
  renderAll();
}

async function pick(mode) {
  document.querySelector("#pick-multi").disabled = true;
  document.querySelector("#pick-one").disabled = true;
  setStatus(mode === "one" ? "正在打开文件夹窗口…" : "正在打开多选文件夹窗口。如果它在任务栏闪烁，请点开它。");
  try {
    const data = await postJson("/api/pick", { mode });
    if (data.paths?.length) addRoots(data.paths);
    else setStatus("没有添加新目录。");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (!state.running) {
      document.querySelector("#pick-multi").disabled = false;
      document.querySelector("#pick-one").disabled = false;
    }
  }
}

async function scan() {
  if (!state.roots.length) {
    setStatus("请先添加要扫描的文件夹。", true);
    return;
  }
  save();
  state.groups = [];
  state.jobId = "";
  renderAll();
  setBusy(true);
  setStatus("正在开始扫描…");
  try {
    const data = await postJson("/api/scan", {
      roots: state.roots,
      kinds: currentKinds(),
      nameMode: document.querySelector("input[name=name-mode]:checked").value,
      toleranceSec: Number(document.querySelector("#tolerance").value) || 0,
      matchWithoutTime: document.querySelector("#without-time").checked,
      similar: document.querySelector("#similar").checked,
      similarDistance: Number(document.querySelector("#similar-distance").value),
    });
    state.jobId = data.jobId;
    listen(data.jobId);
  } catch (error) {
    setBusy(false);
    setStatus(error.message, true);
  }
}

resultsEl.addEventListener("change", (event) => {
  const target = event.target;
  const card = target.closest(".group");
  if (!card || !state.jobId) return;
  const group = state.groups.find((item) => item.id === card.dataset.id);
  if (!group) return;
  if (target.dataset.role === "enable") {
    group.enabled = target.checked;
    updateTotals();
    enqueue(() => postJson(`/api/jobs/${state.jobId}/group`, { groupId: group.id, enabled: group.enabled }).catch((error) => setStatus(error.message, true)));
    return;
  }
  const file = group.files.find((item) => item.path === target.dataset.path);
  if (!file) return;
  let role = file.role;
  if (target.dataset.role === "keep" && target.checked) role = "keep";
  if (target.dataset.role === "drop") role = target.checked ? "delete" : "spare";
  if (role === file.role) return;
  if (role !== "keep" && file.role === "keep") {
    target.checked = file.role === "keep";
    setStatus("请先把另一份标为留下。", true);
    return;
  }
  if (role === "keep") {
    for (const item of group.files) {
      if (item !== file && item.role === "keep") item.role = "delete";
    }
  }
  file.role = role;
  group.wasted = group.files.filter((item) => item.role === "delete").reduce((sum, item) => sum + item.size, 0);
  card.replaceWith(renderGroup(group));
  updateTotals();
  enqueue(() => postJson(`/api/jobs/${state.jobId}/file`, { groupId: group.id, path: file.path, role }).catch((error) => setStatus(error.message, true)));
});

resultsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !state.jobId) return;
  if (button.dataset.action === "toggle") {
    const card = button.closest(".group");
    const group = state.groups.find((item) => item.id === card?.dataset.id);
    if (!group) return;
    group.open = !group.open;
    card.replaceWith(renderGroup(group));
    return;
  }
  if (button.dataset.action === "preview" || button.dataset.action === "preview-group") {
    const card = button.closest(".group");
    const group = state.groups.find((item) => item.id === card?.dataset.id);
    if (!group) return;
    group.showPreview = !group.showPreview;
    if (group.showPreview) group.open = true;
    card.replaceWith(renderGroup(group));
    return;
  }
  const filePath = button.dataset.path;
  if (button.dataset.action === "reveal") {
    setStatus("正在打开文件所在位置…");
    postJson("/api/reveal", { path: filePath })
      .then(() => setStatus("已在资源管理器中定位这个文件。"))
      .catch((error) => setStatus(error.message, true));
  }
});

document.querySelector("#pick-multi").addEventListener("click", () => pick("multi"));
document.querySelector("#pick-one").addEventListener("click", () => pick("one"));
document.querySelector("#clear-roots").addEventListener("click", () => {
  state.roots = [];
  renderRoots();
  save();
});
document.querySelector("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  renderAll();
});
document.querySelector("#toggle-open").addEventListener("click", () => {
  state.expandAll = !state.expandAll;
  for (const group of state.groups) group.open = state.expandAll;
  renderAll();
});
document.querySelector("#scan").addEventListener("click", scan);
document.querySelector("#stop").addEventListener("click", () => {
  if (state.jobId) postJson(`/api/jobs/${state.jobId}/cancel`).catch((error) => setStatus(error.message, true));
});
document.querySelector("#export").addEventListener("click", () => {
  if (state.jobId) window.location.href = `/api/jobs/${state.jobId}/report.csv`;
});
document.querySelector("#delete").addEventListener("click", () => {
  const stat = totals();
  if (!stat.deleteCount) return;
  const similarCount = state.groups.filter((group) => group.enabled && group.kind === "similar" && group.files.some((file) => file.role === "delete")).length;
  const similarText = similarCount ? `其中 ${similarCount} 组只是画面相似，文件字节并不完全相同。` : "";
  modalText.textContent = `将把 ${stat.deleteCount} 个文件移入回收站，约释放 ${formatBytes(stat.wasted)}。${similarText}每组都会留下一份，之后可以在回收站还原。`;
  modal.hidden = false;
});
document.querySelector("#modal-cancel").addEventListener("click", () => {
  modal.hidden = true;
});
document.querySelector("#modal-ok").addEventListener("click", async () => {
  modal.hidden = true;
  document.querySelector("#delete").disabled = true;
  setStatus("正在移入回收站…");
  try {
    await state.queue;
    const data = await postJson(`/api/jobs/${state.jobId}/delete`, {
      includeSidecars: document.querySelector("#sidecars").checked,
    });
    state.groups = data.groups || [];
    const skipped = data.skipped?.length ? `有 ${data.skipped.length} 个未删除。` : "";
    const side = data.sidecars?.filter((item) => item.ok).length;
    const sideText = side ? `附属文件 ${side} 个已一并移入回收站。` : "";
    setStatus(`已移入回收站 ${data.deleted.length} 个文件，释放 ${formatBytes(data.freedBytes)}。${sideText}${skipped}`);
    renderAll();
  } catch (error) {
    setStatus(error.message, true);
    updateTotals();
  }
});

const saved = load();
if (Array.isArray(saved.roots)) state.roots = saved.roots.filter((item) => typeof item === "string");
if (saved.kinds) {
  document.querySelector("#kind-raw").checked = saved.kinds.dslrRaw !== false;
  document.querySelector("#kind-jpeg").checked = saved.kinds.dslrJpeg !== false || saved.kinds.applePhoto !== false;
  document.querySelector("#kind-apple").checked = saved.kinds.applePhoto !== false;
  document.querySelector("#kind-video").checked = saved.kinds.video !== false;
}
if (["normalized", "exact", "ignore"].includes(saved.nameMode)) {
  const input = document.querySelector(`input[name="name-mode"][value="${saved.nameMode}"]`);
  if (input) input.checked = true;
}
if (saved.tolerance != null) document.querySelector("#tolerance").value = saved.tolerance;
if (saved.withoutTime != null) document.querySelector("#without-time").checked = saved.withoutTime !== false;
if (saved.similar != null) document.querySelector("#similar").checked = saved.similar !== false;
if (saved.similarDistance != null) document.querySelector("#similar-distance").value = saved.similarDistance;
if (saved.sidecars != null) document.querySelector("#sidecars").checked = saved.sidecars !== false;
renderRoots();
renderAll();
setStatus("添加目录后开始扫描。带「副本」或「(1)」的文件名会和原文件名认成同一张。");
