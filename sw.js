const CACHE_NAME = "viraasat-pos-shell-v7";
const SHELL_ASSETS = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./sw.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_ASSETS).catch(() => {}))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(cacheNames =>
            Promise.all(
                cacheNames.map(cache => cache === CACHE_NAME ? null : caches.delete(cache))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    if (event.request.url.includes("/api/")) return;

    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone)).catch(() => {});
                return networkResponse;
            })
            .catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
});
