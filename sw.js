const CACHE_NAME = "viraasat-pos-dynamic-v2";

// Install: Skip waiting to force immediate update
self.addEventListener("install", event => {
    self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch: Network First, Fallback to Cache
self.addEventListener("fetch", event => {
    // Only cache GET requests
    if (event.request.method !== "GET") return;

    // Do not cache API calls
    if (event.request.url.includes("/api/")) return;

    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // Save the newest version to cache
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseClone);
                });
                return networkResponse;
            })
            .catch(() => {
                // If offline, serve from cache
                return caches.match(event.request);
            })
    );
});
