const CACHE = "desk-shell-v5-20261126";
const ASSETS = [
  "./",
  "./index.html",
  "./app.css?v=5",
  "./app.js?v=5",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/") || url.pathname.endsWith(".jpg") || url.pathname.endsWith("demo.json")) {
    return;
  }
  // Network first so a new version is picked up on the next open; cache only when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Grok Bot", body: "Desk update" };
  try {
    if (event.data) payload = event.data.json();
  } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(payload.title || "Grok Bot", {
      body: payload.body || "",
      icon: "./icon-192.png",
      data: { url: payload.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(clients.openWindow(target));
});
