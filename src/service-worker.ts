/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const CACHE_PREFIX = 'cordn-app';
const CACHE_NAME = `${CACHE_PREFIX}-${version}`;
const APP_SHELL = '/index.html';
const LEGACY_APP_SHELL = '/200.html';
const ASSETS = [...build, ...files];

const worker = self as unknown as ServiceWorkerGlobalScope;

// Capacitor serves the app shell from the local bundle, so the SW's caching is
// redundant there and would serve stale assets after a `cap sync` update. On the
// native WebView origin (https://localhost) the SW still registers but stays a
// no-op. (Dev uses http://localhost:<port>, prod web a real domain — neither matches.)
const isNativeCapacitor = worker.location.origin === 'https://localhost';

worker.addEventListener('install', (event) => {
	if (isNativeCapacitor) return;
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => worker.skipWaiting())
	);
});

worker.addEventListener('activate', (event) => {
	if (isNativeCapacitor) return;
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
						.map((key) => caches.delete(key))
				)
			)
			.then(() => worker.clients.claim())
	);
});

worker.addEventListener('fetch', (event) => {
	if (isNativeCapacitor) return;
	if (event.request.method !== 'GET') {
		return;
	}

	const url = new URL(event.request.url);
	if (url.origin !== worker.location.origin) {
		return;
	}

	if (event.request.mode === 'navigate') {
		event.respondWith(networkFirst(event.request));
		return;
	}

	// The version marker must always be fetched fresh so update polling
	// (src/lib/services/appUpdate.svelte.ts) never reads a stale cached copy.
	if (url.pathname === '/version.json') {
		event.respondWith(fetch(event.request));
		return;
	}

	if (ASSETS.includes(url.pathname)) {
		event.respondWith(cacheFirst(event.request));
	}
});

async function cacheFirst(request: Request): Promise<Response> {
	const cached = await caches.match(request);
	if (cached) {
		return cached;
	}

	const response = await fetch(request);
	const cache = await caches.open(CACHE_NAME);
	cache.put(request, response.clone()).catch(() => undefined);
	return response;
}

async function networkFirst(request: Request): Promise<Response> {
	try {
		const response = await fetch(request);
		const cache = await caches.open(CACHE_NAME);
		cache.put(request, response.clone()).catch(() => undefined);
		return response;
	} catch {
		return (
			(await caches.match(request)) ??
			(await caches.match(APP_SHELL)) ??
			(await caches.match(LEGACY_APP_SHELL)) ??
			Response.error()
		);
	}
}

export {};
