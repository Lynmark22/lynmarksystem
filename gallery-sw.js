const GALLERY_SW_VERSION = '20260416.11';
const GALLERY_MEDIA_CACHE = 'lynmark-gallery-media-v1';
const GALLERY_STATIC_CACHE = `lynmark-gallery-static-${GALLERY_SW_VERSION}`;
const GALLERY_MAX_MEDIA_ENTRIES = 220;
const GALLERY_MAX_STATIC_ENTRIES = 36;
const GALLERY_SUPABASE_HOST = 'jlbvoiqexugdobzgpvyb.supabase.co';
const GALLERY_BUCKET_PATH = '/storage/v1/object/public/lynmark-gallery/';

function isGalleryMediaRequest(url) {
    return url.hostname === GALLERY_SUPABASE_HOST && url.pathname.includes(GALLERY_BUCKET_PATH);
}

function isStaticGalleryAsset(url) {
    if (url.origin !== self.location.origin) return false;

    return /\.(?:css|js|png|jpg|jpeg|webp|ico|svg|woff2?)$/i.test(url.pathname)
        || url.pathname.endsWith('/vendor/supabase-js.umd.js')
        || url.pathname.endsWith('/normalize.css');
}

function getMediaCacheLookupRequests(request) {
    const url = new URL(request.url);
    const lookupUrls = [request.url];

    if (url.searchParams.has('download')) {
        url.searchParams.delete('download');
        lookupUrls.push(url.toString());
    }

    return lookupUrls.map((lookupUrl) => new Request(lookupUrl, {
        method: 'GET',
        mode: request.mode,
        credentials: request.credentials,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity
    }));
}

async function matchCachedMedia(cache, request) {
    const lookupRequests = getMediaCacheLookupRequests(request);

    for (const lookupRequest of lookupRequests) {
        const cachedResponse = await cache.match(lookupRequest);
        if (cachedResponse) return cachedResponse;
    }

    return null;
}

function shouldNormalizeMediaCacheKey(request) {
    const url = new URL(request.url);
    return url.searchParams.has('download');
}

function getNormalizedMediaCacheRequest(request) {
    const url = new URL(request.url);
    url.searchParams.delete('download');

    if (!shouldNormalizeMediaCacheKey(request)) return request;

    return new Request(url.toString(), {
        method: 'GET',
        headers: request.headers,
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity
    });
}

async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;

    const deleteCount = keys.length - maxEntries;
    await Promise.all(keys.slice(0, deleteCount).map((key) => cache.delete(key)));
}

async function createRangeResponse(request, cachedResponse) {
    const rangeHeader = request.headers.get('range');
    if (!rangeHeader || !cachedResponse || cachedResponse.status !== 200 || cachedResponse.type === 'opaque') {
        return null;
    }

    const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
    if (!rangeMatch) return null;

    const blob = await cachedResponse.clone().blob();
    if (!blob.size) return null;

    const start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
    const end = rangeMatch[2] ? Number(rangeMatch[2]) : blob.size - 1;
    const safeStart = Math.max(0, Math.min(start, blob.size - 1));
    const safeEnd = Math.max(safeStart, Math.min(end, blob.size - 1));
    const chunk = blob.slice(safeStart, safeEnd + 1);
    const contentType = cachedResponse.headers.get('content-type') || blob.type || 'application/octet-stream';

    return new Response(chunk, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': String(chunk.size),
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${blob.size}`,
            'Content-Type': contentType
        }
    });
}

async function cacheFirstMedia(request) {
    const cache = await caches.open(GALLERY_MEDIA_CACHE);

    if (request.headers.has('range')) {
        const cachedFullResponse = await matchCachedMedia(cache, request);
        const rangeResponse = await createRangeResponse(request, cachedFullResponse);
        if (rangeResponse) return rangeResponse;

        return fetch(request);
    }

    const cachedResponse = await matchCachedMedia(cache, request);
    if (cachedResponse) return cachedResponse;

    const response = await fetch(request);
    const isCacheable = response
        && response.status !== 206
        && (response.ok || response.type === 'opaque');

    if (isCacheable) {
        cache.put(getNormalizedMediaCacheRequest(request), response.clone())
            .then(() => trimCache(GALLERY_MEDIA_CACHE, GALLERY_MAX_MEDIA_ENTRIES))
            .catch(() => {});
    }

    return response;
}

async function staleWhileRevalidateStatic(request) {
    const cache = await caches.open(GALLERY_STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    const fetchPromise = fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone())
                    .then(() => trimCache(GALLERY_STATIC_CACHE, GALLERY_MAX_STATIC_ENTRIES))
                    .catch(() => {});
            }

            return response;
        })
        .catch(() => cachedResponse);

    return cachedResponse || fetchPromise;
}

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => key.startsWith('lynmark-gallery-static-') && key !== GALLERY_STATIC_CACHE)
                .map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (isGalleryMediaRequest(url)) {
        event.respondWith(cacheFirstMedia(request));
        return;
    }

    if (isStaticGalleryAsset(url)) {
        event.respondWith(staleWhileRevalidateStatic(request));
    }
});
