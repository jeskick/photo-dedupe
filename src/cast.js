import dgram from "node:dgram";
import http from "node:http";
import { randomBytes } from "node:crypto";

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
};

const tickets = new Map();

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

export async function pushMedia(device, media) {
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
