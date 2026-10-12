import test from "node:test";
import assert from "node:assert/strict";
import { bitrateFromBoxes, castPlan, castTicket, chooseCastDevices, formatBitrate, lanHostFor, parseLauncherInfo, parseRendererDescription, rememberCast, rememberPlaylist, soapBody, stepPlaylist, subnetHosts } from "../src/cast.js";

const renderer = `<?xml version="1.0"?>
<root>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>我的小电视</friendlyName>
    <UDN>uuid:tv-1</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/bilibili/AVTransport/tv-1/control.xml</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

test("只把带 AVTransport 的渲染器当成电视", () => {
  const device = parseRendererDescription(renderer, "http://192.168.8.223:9958/bilibili/description.xml");
  assert.equal(device.name, "我的小电视");
  assert.equal(device.id, "uuid:tv-1");
  assert.equal(device.controlUrl, "http://192.168.8.223:9958/bilibili/AVTransport/tv-1/control.xml");
  assert.equal(parseRendererDescription("<device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>路由</friendlyName></device>", "http://192.168.8.1:8200/rootDesc.xml"), null);
});

test("投屏地址用和电视同一网段的本机地址", () => {
  assert.equal(lanHostFor("192.168.8.223", ["127.0.0.1", "192.168.8.147", "10.0.0.4"]), "192.168.8.147");
});

test("照片和视频按电视能打开的类型准备", () => {
  assert.deepEqual(castPlan(".jpg"), { kind: "image", mime: "image/jpeg", mode: "file", suffix: ".jpg" });
  assert.equal(castPlan(".HEIC").mode, "jpeg");
  assert.equal(castPlan(".CR2").suffix, ".jpg");
  assert.equal(castPlan(".mp4").kind, "video");
  assert.equal(castPlan(".m4v").suffix, ".mp4");
});

test("投屏指令会转义标题和地址", () => {
  const body = soapBody("SetAVTransportURI", { CurrentURI: "http://192.168.8.147/a&b.jpg", CurrentURIMetaData: `<DIDL-Lite><dc:title>A & B</dc:title></DIDL-Lite>` });
  assert.match(body, /A &amp; B/);
  assert.match(body, /a&amp;b\.jpg/);
  assert.doesNotMatch(body, /<dc:title>/);
});

test("桌面启动器优先于只应答不显示的投屏服务", () => {
  const launcher = parseLauncherInfo('{"ok":true,"name":"KK桌面","package":"com.kk.tvlauncher"}', "192.168.8.223");
  assert.equal(launcher.kind, "launcher");
  assert.equal(launcher.name, "KK桌面");
  assert.equal(launcher.packageName, "com.kk.tvlauncher");
  assert.equal(parseLauncherInfo('{"ok":false}', "192.168.8.223"), null);
  const dlna = { id: "bili", name: "我的小电视", controlUrl: "http://192.168.8.223:9958/bilibili/control.xml" };
  const picked = chooseCastDevices([launcher], [dlna], ["192.168.8.223"]);
  assert.equal(picked[0].kind, "launcher");
  assert.equal(picked[1].kind, "android");
  assert.equal(picked[1].name, "索尼电视");
  assert.equal(chooseCastDevices([], [dlna], ["192.168.8.223"])[0].kind, "android");
  assert.equal(chooseCastDevices([], [dlna]).length, 0);
  assert.equal(subnetHosts(["192.168.8.147"]).includes("192.168.8.223"), true);
  assert.equal(subnetHosts(["127.0.0.1"]).length, 0);
});

test("从 mvhd 算出视频码率", () => {
  const box = Buffer.alloc(40);
  box.write("mvhd", 0);
  box.writeUInt32BE(1000, 16);
  box.writeUInt32BE(8000, 20);
  assert.equal(bitrateFromBoxes(box, 1_000_000), 1_000_000);
  assert.equal(formatBitrate(18_400_000), "18.4 Mbps");
  assert.equal(formatBitrate(0), "");
});

test("遥控器上下键在当前这组照片里移动", () => {
  const token = rememberPlaylist(["a.jpg", "b.jpg", "c.jpg"], 1);
  assert.equal(stepPlaylist(token, "prev").path, "a.jpg");
  assert.equal(stepPlaylist(token, "prev").edge, true);
  assert.equal(stepPlaylist(token, "next").path, "b.jpg");
  assert.equal(stepPlaylist("missing", "next"), null);
});

test("投屏链接只在有效期内能找到原文件", () => {
  const token = rememberCast({ path: "D:\\照片\\a.jpg", mime: "image/jpeg", mode: "file" });
  assert.equal(castTicket(token).path, "D:\\照片\\a.jpg");
  assert.equal(castTicket("missing"), null);
});
