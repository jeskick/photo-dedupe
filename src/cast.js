import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const LAUNCHER_PORT = 9978;

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
};

const tickets = new Map();
const playlists = new Map();

export function castPlan(ext) {
  const lower = String(ext || "").toLowerCase();
  if (VIDEO_TYPES[lower]) {
    return { kind: "video", mime: VIDEO_TYPES[lower], mode: "file", suffix: lower === ".m4v" ? ".mp4" : lower };
  }
  if (lower === ".png") return { kind: "image", mime: "image/png", mode: "file", suffix: ".png" };
  if (lower === ".jpg" || lower === ".jpeg") return { kind: "image", mime: "image/jpeg", mode: "file", suffix: ".jpg" };
  return { kind: "image", mime: "image/jpeg", mode: "jpeg", suffix: ".jpg" };
}

export function lanHostFor(targetHost, addresses) {
  const target = String(targetHost || "").split(".");
  let best = "";
  let score = -1;
  for (const address of addresses || []) {
    const parts = String(address).split(".");
    let same = 0;
    while (same < 4 && parts[same] && parts[same] === target[same]) same += 1;
    if (same > score) {
      score = same;
      best = address;
    }
  }
  return best;
}

export function dlnaHeaders() {
  return {
    "transferMode.dlna.org": "Streaming",
    "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
  };
}

export function rememberCast(ticket) {
  const now = Date.now();
  for (const [key, item] of tickets) {
    if (item.expires < now) tickets.delete(key);
  }
  const token = randomBytes(9).toString("hex");
  tickets.set(token, { ...ticket, expires: now + 2 * 60 * 60 * 1000 });
  return token;
}

export function rememberPlaylist(paths, index) {
  const now = Date.now();
  for (const [key, item] of playlists) {
    if (item.expires < now) playlists.delete(key);
  }
  const list = (paths || []).map((item) => String(item || "")).filter(Boolean);
  if (!list.length) return "";
  const token = randomBytes(9).toString("hex");
  const at = Math.min(Math.max(0, Number(index) || 0), list.length - 1);
  playlists.set(token, { paths: list, index: at, expires: now + 2 * 60 * 60 * 1000 });
  return token;
}

export function stepPlaylist(token, dir) {
  const item = playlists.get(String(token || ""));
  if (!item || item.expires < Date.now()) return null;
  const next = item.index + (dir === "prev" ? -1 : 1);
  if (next < 0 || next >= item.paths.length) {
    return { path: item.paths[item.index], index: item.index, edge: true };
  }
  item.index = next;
  return { path: item.paths[next], index: next, edge: false };
}

export function castTicket(token) {
  const item = tickets.get(String(token || ""));
  if (!item) return null;
  if (item.expires < Date.now()) {
    tickets.delete(String(token || ""));
    return null;
  }
  return item;
}

export function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tag(xml, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(String(xml || ""));
  return match ? decodeXml(match[1].trim()) : "";
}

export function parseRendererDescription(xml, location) {
  const text = String(xml || "");
  if (!/MediaRenderer:1/i.test(text)) return null;
  const name = tag(text, "friendlyName");
  const udn = tag(text, "UDN");
  const service = text.split(/<service>/i).find((part) => /AVTransport:1/i.test(part));
  const control = service ? tag(service, "controlURL") : "";
  if (!name || !control) return null;
  let controlUrl = "";
  try {
    controlUrl = new URL(control, location).href;
  } catch {
    return null;
  }
  if (!controlUrl.startsWith("http://") && !controlUrl.startsWith("https://")) return null;
  return { id: udn || controlUrl, name, controlUrl };
}

export function soapBody(action, fields) {
  const inner = Object.entries(fields || {}).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${action}></s:Body></s:Envelope>`;
}

function didl(media) {
  const klass = media.kind === "video" ? "object.item.videoItem" : "object.item.imageItem";
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`
    + `<item id="0" parentID="-1" restricted="1">`
    + `<dc:title>${xmlEscape(media.title || "照片")}</dc:title>`
    + `<upnp:class>${klass}</upnp:class>`
    + `<res protocolInfo="http-get:*:${media.mime}:*">${xmlEscape(media.url)}</res>`
    + `</item></DIDL-Lite>`;
}

function faultText(xml) {
  return tag(xml, "errorDescription") || tag(xml, "faultstring");
}

function soap(controlUrl, action, fields) {
  const body = Buffer.from(soapBody(action, fields));
  const url = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      headers: {
        "Content-Type": "text/xml; charset=\"utf-8\"",
        SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        "Content-Length": body.length,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode || 500) >= 400 || /<(?:\w+:)?Fault[\s>]/i.test(text) || /<UPnPError[\s>]/i.test(text)) {
          resolve({ ok: false, error: faultText(text) || `电视返回 ${res.statusCode || 500}` });
          return;
        }
        resolve({ ok: true });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("电视没有响应")));
    req.end(body);
  });
}

export function parseLauncherInfo(body, host) {
  let data = body;
  if (typeof body === "string") {
    try { data = JSON.parse(body); } catch { return null; }
  }
  if (!data || data.ok !== true || !data.name) return null;
  const packageName = /^[a-zA-Z0-9_.]+$/.test(String(data.package || "")) ? String(data.package) : "";
  return {
    id: `launcher:${host}`,
    name: String(data.name),
    controlUrl: `http://${host}:${LAUNCHER_PORT}/cast/play`,
    host,
    packageName,
    kind: "launcher",
  };
}

export function subnetHosts(addresses) {
  const hosts = [];
  for (const address of addresses || []) {
    const parts = String(address).split(".");
    if (parts.length !== 4 || parts[0] === "127") continue;
    const prefix = parts.slice(0, 3).join(".");
    for (let index = 1; index <= 254; index += 1) hosts.push(`${prefix}.${index}`);
  }
  return [...new Set(hosts)];
}

export function chooseCastDevices(launchers, renderers, androidHosts = []) {
  const ready = (launchers || []).filter(Boolean);
  const android = new Set(androidHosts);
  const systems = [];
  const seen = new Set();
  for (const device of renderers || []) {
    let host = "";
    try { host = new URL(device.controlUrl).hostname; } catch { host = ""; }
    if (!host || !android.has(host) || seen.has(host)) continue;
    seen.add(host);
    systems.push({ ...device, host, kind: "android", name: "索尼电视" });
  }
  return [...ready, ...systems];
}

export function bitrateFromBoxes(buf, size) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  for (let index = 0; index + 28 < data.length; index += 1) {
    if (data.toString("latin1", index, index + 4) !== "mvhd") continue;
    const version = data[index + 4];
    let timescale = 0;
    let duration = 0;
    if (version === 0) {
      timescale = data.readUInt32BE(index + 16);
      duration = data.readUInt32BE(index + 20);
    } else if (version === 1 && index + 36 < data.length) {
      timescale = data.readUInt32BE(index + 24);
      duration = Number(data.readBigUInt64BE(index + 28));
    }
    if (!timescale || !duration) continue;
    const seconds = duration / timescale;
    if (seconds < 0.1 || seconds > 86400) continue;
    return Math.round(Number(size) * 8 / seconds);
  }
  return 0;
}

export function formatBitrate(bits) {
  const value = Number(bits) || 0;
  if (value < 1000) return "";
  const kbps = value / 1000;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function videoBitrate(filePath) {
  const stat = fs.statSync(filePath);
  const readAt = (start, length) => {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, start);
      return buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  };
  const headLen = Math.min(stat.size, 512 * 1024);
  const head = bitrateFromBoxes(readAt(0, headLen), stat.size);
  if (head) return head;
  if (stat.size <= headLen) return 0;
  const tailLen = Math.min(stat.size, 2 * 1024 * 1024);
  return bitrateFromBoxes(readAt(stat.size - tailLen, tailLen), stat.size);
}

function adbExecutable() {
  if (process.env.ADB && fs.existsSync(process.env.ADB)) return process.env.ADB;
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tools", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  if (fs.existsSync(bundled)) return bundled;
  const temp = path.join(process.env.TEMP || process.env.TMP || "", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  if (fs.existsSync(temp)) return temp;
  return "adb";
}

function runAdb(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbExecutable(), args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("电视没有响应调试"));
    }, 8000);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function pushAndroid(host, media) {
  const connect = await runAdb(["connect", `${host}:5555`]);
  if (/unauthorized|failed to authenticate|无法连接/i.test(connect)) {
    throw new Error("请在电视上点「允许」调试，然后再投一次");
  }
  const component = media.kind === "video"
    ? "com.sony.dtv.smartmediaapp/com.sonyericsson.video.player.PlayerActivity"
    : "com.sony.dtv.smartmediaapp/.SlideshowPermissionActivity";
  await runAdb(["-s", `${host}:5555`, "shell", "am", "force-stop", "com.sony.dtv.smartmediaapp"]).catch(() => {});
  let view = await runAdb(["-s", `${host}:5555`, "shell", "am", "start", "-n", component, "-a", "android.intent.action.VIEW", "-d", media.url, "-t", media.mime]);
  if (/Error|Exception|unable to resolve/i.test(view)) {
    view = await runAdb(["-s", `${host}:5555`, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", media.url, "-t", media.mime]);
  }
  if (/unauthorized|failed to authenticate/i.test(view)) {
    throw new Error("请在电视上点「允许」调试，然后再投一次");
  }
  if (/Error|Exception/i.test(view)) throw new Error("电视没有打开这张照片");
}

function postJson(target, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
      timeout: 8000,
    }, (res) => {
      res.resume();
      if ((res.statusCode || 500) >= 400) reject(new Error("桌面没有接住投屏"));
      else resolve();
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("桌面没有响应")));
    req.end(body);
  });
}

async function pushLauncher(host, packageName, media) {
  const connect = await runAdb(["connect", `${host}:5555`]);
  if (/unauthorized|failed to authenticate|无法连接/i.test(connect)) {
    throw new Error("请在电视上点「允许」调试，然后再投一次");
  }
  const view = await runAdb([
    "-s", `${host}:5555`, "shell", "am", "start", "-n",
    `${packageName}/com.kk.tvlauncher.ui.CastPlayActivity`,
    "--es", "url", media.url,
    "--es", "kind", media.kind || "image",
    "--es", "step", media.step || "",
  ]);
  if (/unauthorized|failed to authenticate/i.test(view)) {
    throw new Error("请在电视上点「允许」调试，然后再投一次");
  }
  if (/Error|Exception|does not exist|unable to resolve/i.test(view)) throw new Error("桌面没有打开这张照片");
}

export async function pushMedia(device, media) {
  if (device.kind === "launcher") {
    if (device.packageName && device.host) {
      await pushLauncher(device.host, device.packageName, media);
      return;
    }
    await postJson(device.controlUrl, {
      url: media.url,
      mime: media.mime,
      title: media.title,
      kind: media.kind,
    });
    return;
  }
  if (device.kind === "android" && device.host) {
    await pushAndroid(device.host, media);
    return;
  }
  await soap(device.controlUrl, "Stop", { InstanceID: "0" }).catch(() => {});
  const set = await soap(device.controlUrl, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: media.url,
    CurrentURIMetaData: didl(media),
  });
  if (!set.ok) throw new Error(set.error || "电视没有接受");
  const play = await soap(device.controlUrl, "Play", { InstanceID: "0", Speed: "1" });
  if (!play.ok) throw new Error(play.error || "电视没有开始播放");
}

function fetchText(location) {
  return new Promise((resolve, reject) => {
    const req = http.get(location, { timeout: 2500 }, (res) => {
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        reject(new Error(String(res.statusCode)));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("描述超时")));
  });
}

export function discoverRenderers(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const locations = new Set();
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      const devices = [];
      const seen = new Set();
      for (const location of locations) {
        try {
          const device = parseRendererDescription(await fetchText(location), location);
          if (!device || seen.has(device.id)) continue;
          seen.add(device.id);
          devices.push(device);
        } catch { /* skip this description */ }
      }
      resolve(devices);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", () => finish());
    socket.on("message", (buf) => {
      const loc = /^LOCATION:\s*(\S+)/im.exec(buf.toString("latin1"));
      if (loc) locations.add(loc[1]);
    });
    socket.bind(0, () => {
      try { socket.addMembership("239.255.255.250"); } catch { /* still send the search */ }
      try { socket.setMulticastTTL(2); } catch { /* optional */ }
      const msg = Buffer.from([
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        "MAN: \"ssdp:discover\"",
        "MX: 1",
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
        "",
        "",
      ].join("\r\n"));
    socket.send(msg, 1900, "239.255.255.250");
    });
  });
}

function portOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

function readLauncher(host) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: LAUNCHER_PORT, path: "/cast/info", timeout: 800 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(parseLauncherInfo(Buffer.concat(chunks).toString("utf8"), host)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function discoverLaunchers(hosts) {
  const found = [];
  const seen = new Set();
  for (let index = 0; index < hosts.length; index += 80) {
    const batch = hosts.slice(index, index + 80);
    const open = await Promise.all(batch.map(async (host) => (await portOpen(host, LAUNCHER_PORT)) ? host : ""));
    const infos = await Promise.all(open.filter(Boolean).map(readLauncher));
    for (const device of infos) {
      if (!device || seen.has(device.id)) continue;
      seen.add(device.id);
      found.push(device);
    }
  }
  return found;
}

export async function discoverScreens(addresses) {
  const [renderers, launchers] = await Promise.all([
    discoverRenderers(),
    discoverLaunchers(subnetHosts(addresses)),
  ]);
  const hosts = new Set();
  for (const device of renderers) {
    try { hosts.add(new URL(device.controlUrl).hostname); } catch { /* skip */ }
  }
  for (const device of launchers) {
    if (device.host) hosts.add(device.host);
  }
  const android = [];
  await Promise.all([...hosts].map(async (host) => {
    if (await portOpen(host, 5555, 700)) android.push(host);
  }));
  return chooseCastDevices(launchers, renderers, android);
}
