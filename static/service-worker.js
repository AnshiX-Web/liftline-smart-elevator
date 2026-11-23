const CACHE_NAME = "liftline-shell-v4";
const APP_SHELL = ["/", "/static/app.js", "/static/manifest.json", "/static/icon.svg"];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
        return;
    }
    event.respondWith((async () => {
        const cacheKey = url.pathname === "/" ? "/" : event.request;
        const cached = await caches.match(cacheKey);
        const network = fetch(event.request).then((response) => {
            if (response.ok && response.type === "basic") {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
        });
        if (cached) {
            event.waitUntil(network.catch(() => {}));
            return cached;
        }
        try {
            return await network;
        } catch {
            return new Response("Liftline is offline. Use the elevator intercom or established emergency procedure.", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }
    })());
});

self.addEventListener("sync", (event) => {
    if (event.tag === "liftline-emergency-outbox") {
        event.waitUntil(syncEmergencyOutbox());
    }
});

async function syncEmergencyOutbox() {
    const database = await openDatabase();
    const queue = await new Promise((resolve, reject) => {
        const request = database.transaction("outbox").objectStore("outbox").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    for (const item of queue) {
        try {
            const response = await fetch("/api/emergencies", {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": item.csrf_token || ""
                },
                body: JSON.stringify({
                    elevator_id: item.elevator_id,
                    category: item.category,
                    description: item.description,
                    requester_name: item.requester_name,
                    elevator_token: item.elevator_token,
                    client_request_id: item.client_request_id
                })
            });
            if (!response.ok) continue;
            await new Promise((resolve, reject) => {
                const transaction = database.transaction("outbox", "readwrite");
                transaction.objectStore("outbox").delete(item.client_request_id);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
            const clients = await self.clients.matchAll({ type: "window" });
            clients.forEach((client) => client.postMessage({ type: "liftline-outbox-synced" }));
        } catch {
            return;
        }
    }
    database.close();
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("liftline-offline", 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains("outbox")) {
                request.result.createObjectStore("outbox", { keyPath: "client_request_id" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
