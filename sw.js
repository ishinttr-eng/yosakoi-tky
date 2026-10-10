// 東京よさこいナビ Service Worker
// UI・見た目・ロジックを変更したら必ず VERSION を上げること
const VERSION = "v41";
const CACHE_NAME = `tyk-${VERSION}`;

const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "css/style.css",
  "js/app.js",
  "js/store.js",
  "js/util.js",
  "js/ui/modal.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 1つでも取得に失敗したらinstall自体を失敗させる。不完全なキャッシュのまま
      // 新SWが有効化されて旧キャッシュが消えると、地図などが使えなくなるため（旧SWはそのまま残る）
      await Promise.all(
        APP_SHELL.map(async (url) => {
          const res = await fetch(url, { cache: "reload" });
          if (!res.ok) throw new Error(`precache failed: ${url} (${res.status})`);
          await cache.put(url, res);
        })
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

function isDataRequest(url) {
  return url.pathname.includes("/data/");
}
function isTileRequest(url) {
  return url.hostname.endsWith("tile.openstreetmap.org");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.pathname.endsWith("/help.html")) return; // 使い方ページはアプリ本体と切り離し、常にネットワークから取得する

  if (isTileRequest(url)) return; // 地図タイルはキャッシュしない（容量対策）

  if (isDataRequest(url)) {
    // ネットワーク優先、失敗時のみキャッシュにフォールバック
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          // 404/500などの失敗レスポンスで、保存済みの正常なキャッシュを上書きしない
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          throw new Error("offline and no cache");
        }
      })()
    );
    return;
  }

  // アプリシェル・地図ライブラリ等はキャッシュ優先
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && (url.origin === self.location.origin || APP_SHELL.includes(req.url))) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
        }
        return res;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
