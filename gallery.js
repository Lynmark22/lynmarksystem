import React, { startTransition, useDeferredValue, useEffect, useRef, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';
import * as tus from 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/+esm';

const html = htm.bind(React.createElement);

const SUPABASE_URL = 'https://jlbvoiqexugdobzgpvyb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsYnZvaXFleHVnZG9iemdwdnliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3NTU1MzAsImV4cCI6MjA4MDMzMTUzMH0.2RVENuR1AVPbjM5vBG7c2_fppn3D4zAZCuBFVCI08SA';
const GALLERY_BUCKET = 'lynmark-gallery';
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
const RESUMABLE_UPLOAD_RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];
const SECTION_PREVIEW_LIMIT = 9;
const CONSTRAINED_SECTION_PREVIEW_LIMIT = 4;
const INITIAL_VISIBLE_SECTION_COUNT = 10;
const CONSTRAINED_VISIBLE_SECTION_COUNT = 2;
const SECTION_BATCH_SIZE = 10;
const CONSTRAINED_SECTION_BATCH_SIZE = 2;
const DEFAULT_SLIDESHOW_LIMIT = 360;
const SECTION_BROWSER_PAGE_SIZE_CONSTRAINED = 4;
const SECTION_BROWSER_PAGE_SIZE_MOBILE = 9;
const SECTION_BROWSER_PAGE_SIZE_DESKTOP = 12;
const GALLERY_METADATA_PAGE_SIZE = 48;
const GALLERY_METADATA_PAGE_SIZE_CONSTRAINED = 12;
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg']);
const GALLERY_THEME_STORAGE_KEY = 'gallery_theme_mode';
const GALLERY_PHOTOS_CACHE_KEY = 'gallery_photos_cache_v6';
const GALLERY_PHOTOS_CACHE_LIMIT = 600;
const GALLERY_MEDIA_CACHE_NAME = 'lynmark-gallery-media-v1';
const GALLERY_PHOTOS_CACHE_TTL_MS = 10 * 60 * 1000;
const GALLERY_SLIDESHOW_STATE_KEY = 'gallery_slideshow_state_v1';
const GALLERY_VIDEO_DURATION_CACHE_KEY = 'gallery_video_duration_cache_v1';
const GALLERY_VIDEO_DURATION_CACHE_LIMIT = 500;
const VIDEO_DURATION_PROBE_CONCURRENCY = 2;
const VIDEO_DURATION_PROBE_TIMEOUT_MS = 9000;
const VIDEO_DURATION_ROOT_MARGIN = '360px 0px';
const MEDIA_CACHE_FETCH_CONCURRENCY = 3;
const CONSTRAINED_MEDIA_CACHE_FETCH_CONCURRENCY = 1;
const GALLERY_NEXT_PAGE_ROOT_MARGIN = '880px 0px';
const GALLERY_MEDIA_ROOT_MARGIN = '720px 0px';
const GALLERY_CONSTRAINED_MEDIA_ROOT_MARGIN = '120px 0px';
const GALLERY_OBJECT_CACHE_CONTROL_SECONDS = 60 * 60 * 24 * 365;
const LIGHTBOX_CAPTION_PREVIEW_MAX_LENGTH = 72;
const LIGHTBOX_DESCRIPTION_PREVIEW_MAX_LENGTH = 120;
const AUTO_THEME_DARK_START_HOUR = 18;
const AUTO_THEME_LIGHT_START_HOUR = 7;
const GALLERY_THEME_COLORS = {
    light: '#f2efe8',
    dark: '#0f1625'
};
const videoDurationProbeQueue = [];
const videoDurationProbePending = new Map();
const mediaCacheFetchQueue = [];
const mediaCacheFetchPending = new Map();
let videoDurationProbeActiveCount = 0;
let videoDurationCacheSnapshot = null;
let mediaCacheFetchActiveCount = 0;

function cx(...values) {
    return values.filter(Boolean).join(' ');
}

function getStoredUser() {
    try {
        const raw = localStorage.getItem('billing_user');
        return raw ? JSON.parse(raw) : null;
    } catch (_error) {
        return null;
    }
}

function getStoredSessionToken() {
    try {
        const raw = localStorage.getItem('billing_session');
        if (!raw) return '';
        const session = JSON.parse(raw);
        return String(session?.token || '').trim();
    } catch (_error) {
        return '';
    }
}

function readGalleryPhotoCache() {
    try {
        const raw = localStorage.getItem(GALLERY_PHOTOS_CACHE_KEY);
        if (!raw) return { photos: [], cachedAt: 0, isFresh: false };

        const parsed = JSON.parse(raw);
        const cachedAt = Number(parsed?.cachedAt) || 0;
        const photos = Array.isArray(parsed?.photos) ? parsed.photos : [];

        return {
            photos,
            cachedAt,
            isFresh: cachedAt > 0 && Date.now() - cachedAt < GALLERY_PHOTOS_CACHE_TTL_MS
        };
    } catch (_error) {
        return { photos: [], cachedAt: 0, isFresh: false };
    }
}

function writeGalleryPhotoCache(photos) {
    try {
        localStorage.setItem(GALLERY_PHOTOS_CACHE_KEY, JSON.stringify({
            cachedAt: Date.now(),
            photos: Array.isArray(photos) ? photos.slice(0, GALLERY_PHOTOS_CACHE_LIMIT) : []
        }));
    } catch (_error) {
        null;
    }
}

function readSlideshowState(signature, length) {
    try {
        const raw = localStorage.getItem(GALLERY_SLIDESHOW_STATE_KEY);
        if (!raw) return 0;

        const parsed = JSON.parse(raw);
        if (parsed?.signature !== signature) return 0;

        return clamp(Number(parsed?.index) || 0, 0, Math.max(0, length - 1));
    } catch (_error) {
        return 0;
    }
}

function writeSlideshowState(signature, index) {
    try {
        localStorage.setItem(GALLERY_SLIDESHOW_STATE_KEY, JSON.stringify({
            signature,
            index,
            updatedAt: Date.now()
        }));
    } catch (_error) {
        null;
    }
}

function getUserDisplayName(user) {
    const firstName = String(user?.first_name || '').trim();
    const lastName = String(user?.last_name || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    return fullName || String(user?.username || '').trim() || 'Signed in user';
}

function getUserInitials(user) {
    const displayName = getUserDisplayName(user);
    const parts = displayName.split(/\s+/).filter(Boolean);
    const initials = parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    return initials || 'U';
}

function getUserProfileDetail(user) {
    const room = String(user?.tenant_location || '').trim();
    const username = String(user?.username || '').trim();
    if (room && username) return `${room} / @${username}`;
    if (room) return room;
    if (username) return `@${username}`;
    return 'Account active';
}

function areUsersEquivalent(previousUser, nextUser) {
    return JSON.stringify(previousUser || null) === JSON.stringify(nextUser || null);
}

function normalizeThemeMode(value) {
    return ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
}

function getStoredThemeMode() {
    try {
        return normalizeThemeMode(localStorage.getItem(GALLERY_THEME_STORAGE_KEY));
    } catch (_error) {
        return 'auto';
    }
}

function getSystemTheme() {
    const currentHour = new Date().getHours();
    return currentHour >= AUTO_THEME_DARK_START_HOUR || currentHour < AUTO_THEME_LIGHT_START_HOUR ? 'dark' : 'light';
}

function isConstrainedGalleryDevice() {
    if (typeof window === 'undefined' && typeof navigator === 'undefined') {
        return false;
    }

    const nav = typeof navigator === 'undefined' ? null : navigator;
    const connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
    const effectiveType = String(connection?.effectiveType || '').toLowerCase();
    const saveData = Boolean(connection?.saveData);
    const deviceMemory = Number(nav?.deviceMemory) || 0;
    const hardwareConcurrency = Number(nav?.hardwareConcurrency) || 0;
    const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;

    return saveData
        || effectiveType.includes('2g')
        || effectiveType.includes('3g')
        || (deviceMemory > 0 && deviceMemory <= 2)
        || (hardwareConcurrency > 0 && hardwareConcurrency <= 4)
        || viewportWidth <= 520;
}

function getInitialVisibleSectionCount() {
    return isConstrainedGalleryDevice()
        ? CONSTRAINED_VISIBLE_SECTION_COUNT
        : INITIAL_VISIBLE_SECTION_COUNT;
}

function getSectionBatchSize() {
    return isConstrainedGalleryDevice()
        ? CONSTRAINED_SECTION_BATCH_SIZE
        : SECTION_BATCH_SIZE;
}

function getSectionPreviewLimit() {
    return isConstrainedGalleryDevice()
        ? CONSTRAINED_SECTION_PREVIEW_LIMIT
        : SECTION_PREVIEW_LIMIT;
}

function getGalleryMediaRootMargin() {
    return isConstrainedGalleryDevice()
        ? GALLERY_CONSTRAINED_MEDIA_ROOT_MARGIN
        : GALLERY_MEDIA_ROOT_MARGIN;
}

function getSectionBrowserPageSize() {
    if (typeof window === 'undefined') {
        return SECTION_BROWSER_PAGE_SIZE_DESKTOP;
    }

    if (isConstrainedGalleryDevice()) {
        return SECTION_BROWSER_PAGE_SIZE_CONSTRAINED;
    }

    return window.innerWidth <= 760
        ? SECTION_BROWSER_PAGE_SIZE_MOBILE
        : SECTION_BROWSER_PAGE_SIZE_DESKTOP;
}

function getGalleryMetadataPageSize() {
    return isConstrainedGalleryDevice()
        ? GALLERY_METADATA_PAGE_SIZE_CONSTRAINED
        : GALLERY_METADATA_PAGE_SIZE;
}

function getMediaCacheFetchConcurrency() {
    return isConstrainedGalleryDevice()
        ? CONSTRAINED_MEDIA_CACHE_FETCH_CONCURRENCY
        : MEDIA_CACHE_FETCH_CONCURRENCY;
}

function resolveGalleryTheme(mode, systemTheme = getSystemTheme()) {
    return mode === 'auto' ? systemTheme : mode;
}

function applyGalleryTheme(mode, systemTheme = getSystemTheme()) {
    if (typeof document === 'undefined') {
        return resolveGalleryTheme(mode, systemTheme);
    }

    const resolvedTheme = resolveGalleryTheme(mode, systemTheme);
    const root = document.documentElement;
    const themeColor = document.querySelector('meta[name="theme-color"]');

    root.dataset.galleryThemeMode = mode;
    root.dataset.galleryTheme = resolvedTheme;

    if (themeColor) {
        themeColor.setAttribute('content', GALLERY_THEME_COLORS[resolvedTheme] || GALLERY_THEME_COLORS.light);
    }

    return resolvedTheme;
}

function createSupabaseClient() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Gallery is unavailable right now.');
    }

    return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getDirectStorageOrigin(url) {
    const parsed = new URL(url);

    if (!parsed.hostname.includes('.storage.supabase.')) {
        parsed.hostname = parsed.hostname.replace('.supabase.', '.storage.supabase.');
    }

    return parsed.origin;
}

const RESUMABLE_UPLOAD_ENDPOINT = `${getDirectStorageOrigin(SUPABASE_URL)}/storage/v1/upload/resumable`;

function hashValue(value) {
    const input = String(value || '');
    let hash = 0;

    for (let index = 0; index < input.length; index += 1) {
        hash = (hash * 33 + input.charCodeAt(index)) % 2147483647;
    }

    return hash;
}

function canUseCacheStorage() {
    return typeof caches !== 'undefined' && typeof Request !== 'undefined' && typeof Response !== 'undefined';
}

function getGeneratedPosterCacheUrl(media) {
    const baseUrl = typeof window === 'undefined' ? 'https://lynmark.local' : window.location.origin;
    const cacheId = hashValue(media?.id || media?.storage_path || media?.publicUrl || '');
    return `${baseUrl}/__gallery_generated_video_posters__/${cacheId}.jpg`;
}

async function readCachedBlob(cacheKey) {
    if (!cacheKey || !canUseCacheStorage()) return null;

    const cache = await caches.open(GALLERY_MEDIA_CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (!cached) return null;

    return cached.blob();
}

async function readCachedBlobUrl(cacheKey) {
    const blob = await readCachedBlob(cacheKey);
    return blob ? URL.createObjectURL(blob) : '';
}

async function cacheBlob(cacheKey, blob, contentType = blob?.type || 'application/octet-stream') {
    if (!cacheKey || !blob || !canUseCacheStorage()) return;

    const cache = await caches.open(GALLERY_MEDIA_CACHE_NAME);
    await cache.put(cacheKey, new Response(blob, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable'
        }
    }));
}

async function fetchAndCacheMediaBlob(sourceUrl, cacheKey = sourceUrl) {
    const cachedBlob = await readCachedBlob(cacheKey);
    if (cachedBlob) {
        return cachedBlob;
    }

    const response = await fetch(sourceUrl, {
        mode: 'cors',
        cache: 'force-cache'
    });

    if (!response.ok) {
        throw new Error('Media cache fetch failed.');
    }

    const blob = await response.blob();
    await cacheBlob(cacheKey, blob, response.headers.get('content-type') || blob.type);
    return blob;
}

function flushMediaCacheFetchQueue() {
    while (mediaCacheFetchActiveCount < getMediaCacheFetchConcurrency() && mediaCacheFetchQueue.length) {
        const task = mediaCacheFetchQueue.shift();
        mediaCacheFetchActiveCount += 1;

        fetchAndCacheMediaBlob(task.sourceUrl, task.cacheKey)
            .then(task.resolve)
            .catch(task.reject)
            .finally(() => {
                mediaCacheFetchActiveCount = Math.max(0, mediaCacheFetchActiveCount - 1);
                flushMediaCacheFetchQueue();
            });
    }
}

function scheduleMediaCacheFetch(sourceUrl, cacheKey = sourceUrl) {
    if (!sourceUrl || !canUseCacheStorage()) {
        return Promise.reject(new Error('Media cache is unavailable.'));
    }

    const pendingKey = String(cacheKey || sourceUrl);
    if (mediaCacheFetchPending.has(pendingKey)) {
        return mediaCacheFetchPending.get(pendingKey);
    }

    const scheduledFetch = new Promise((resolve, reject) => {
        mediaCacheFetchQueue.push({
            sourceUrl,
            cacheKey: pendingKey,
            resolve,
            reject
        });
        flushMediaCacheFetchQueue();
    });
    const trackedFetch = scheduledFetch.finally(() => {
        mediaCacheFetchPending.delete(pendingKey);
    });

    mediaCacheFetchPending.set(pendingKey, trackedFetch);
    return trackedFetch;
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatCompactDate(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    }).format(date);
}

function formatDisplayDate(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(date);
}

function formatMonthLabel(value) {
    if (!value) return 'Unknown month';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown month';
    return new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric'
    }).format(date);
}

function getDayKey(value) {
    const date = new Date(value || Date.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getDayHeading(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return 'Unknown Day';

    const now = new Date();
    const todayKey = getDayKey(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = getDayKey(yesterday);
    const targetKey = getDayKey(date);

    if (targetKey === todayKey) return 'Today';
    if (targetKey === yesterdayKey) return 'Yesterday';

    return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
    }).format(date);
}

function fileSizeLabel(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function percentageLabel(value) {
    return `${Math.round(Number(value) || 0)}%`;
}

function uploadSpeedLabel(bytesPerSecond) {
    const speed = Number(bytesPerSecond) || 0;
    if (speed <= 0) return 'Measuring speed...';
    return `${fileSizeLabel(speed)}/s`;
}

function createUploadProgressState(files) {
    const items = files.map((file, index) => ({
        id: `${file.name}-${file.size}-${index}`,
        name: file.name,
        totalBytes: Number(file.size) || 0,
        uploadedBytes: 0,
        percentage: 0,
        speedBytesPerSecond: 0,
        status: 'queued',
        errorMessage: ''
    }));
    const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);

    return {
        items,
        totalBytes,
        uploadedBytes: 0,
        percentage: 0,
        activeIndex: items.length ? 0 : -1,
        activeFileName: items[0]?.name || '',
        speedBytesPerSecond: 0,
        stageLabel: items.length ? `Preparing ${items[0].name}...` : ''
    };
}

function updateUploadProgressState(previous, fileIndex, filePatch = {}, meta = {}) {
    if (!previous || fileIndex < 0 || fileIndex >= previous.items.length) {
        return previous;
    }

    const items = previous.items.map((item, index) => {
        if (index !== fileIndex) return item;

        const totalBytes = Number(filePatch.totalBytes ?? item.totalBytes) || 0;
        const uploadedBytes = clamp(Number(filePatch.uploadedBytes ?? item.uploadedBytes) || 0, 0, totalBytes || Number.MAX_SAFE_INTEGER);

        return {
            ...item,
            ...filePatch,
            totalBytes,
            uploadedBytes,
            percentage: totalBytes ? clamp((uploadedBytes / totalBytes) * 100, 0, 100) : 0
        };
    });

    const totalBytes = previous.totalBytes || items.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
    const uploadedBytes = items.reduce(
        (sum, item) => sum + clamp(Number(item.uploadedBytes) || 0, 0, Number(item.totalBytes) || Number.MAX_SAFE_INTEGER),
        0
    );
    const activeIndex = meta.activeIndex ?? previous.activeIndex;
    const activeItem = items[activeIndex] || null;

    return {
        ...previous,
        items,
        totalBytes,
        uploadedBytes,
        percentage: totalBytes ? clamp((uploadedBytes / totalBytes) * 100, 0, 100) : 0,
        activeIndex,
        activeFileName: meta.activeFileName ?? (activeItem?.name || ''),
        speedBytesPerSecond: meta.speedBytesPerSecond ?? previous.speedBytesPerSecond,
        stageLabel: meta.stageLabel ?? previous.stageLabel
    };
}

function getUploadItemStatusLabel(item) {
    if (!item) return 'Ready';

    switch (item.status) {
        case 'preparing':
            return 'Preparing';
        case 'uploading':
            return `${percentageLabel(item.percentage)} uploaded`;
        case 'finalizing':
            return 'Saving';
        case 'complete':
            return 'Uploaded';
        case 'error':
            return item.errorMessage || 'Upload failed';
        default:
            return 'Waiting';
    }
}

function sanitizeFileName(name) {
    return String(name || 'photo')
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'photo';
}

function safeCaption(input) {
    return String(input || '').trim().replace(/\s+/g, ' ');
}

function truncateText(input, maxLength = LIGHTBOX_CAPTION_PREVIEW_MAX_LENGTH) {
    const value = safeCaption(input);
    const limit = Math.max(4, Number(maxLength) || LIGHTBOX_CAPTION_PREVIEW_MAX_LENGTH);

    if (value.length <= limit) {
        return value;
    }

    const rawClip = value.slice(0, limit - 3).trimEnd();
    const lastSpace = rawClip.lastIndexOf(' ');
    const clipped = lastSpace > limit * 0.55 ? rawClip.slice(0, lastSpace) : rawClip;

    return `${clipped.replace(/[.,;:!?-]+$/g, '').trimEnd()}...`;
}

function buildStoragePath(user, file) {
    const ownerId = user?.id || 'guest';
    const timeKey = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = sanitizeFileName(file.name);
    const extensionMatch = String(file.name || '').match(/\.[a-z0-9]+$/i);
    const extension = extensionMatch ? extensionMatch[0].toLowerCase() : '.jpg';
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${ownerId}/${timeKey}-${randomPart}-${fileName}${extension}`;
}

function getMediaExtension(value) {
    const source = String(value?.storage_path || value?.publicUrl || value?.name || value || '');
    const sanitized = source.split('#')[0].split('?')[0];
    const match = sanitized.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
}

function isVideoMedia(value) {
    const type = String(value?.type || '').toLowerCase();
    if (type.startsWith('video/')) return true;
    if (type.startsWith('image/')) return false;
    return VIDEO_EXTENSIONS.has(getMediaExtension(value));
}

function normalizeVideoDuration(rawDuration) {
    const duration = Number(rawDuration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function getVideoDurationCacheId(media) {
    return String(media?.id || media?.storage_path || media?.publicUrl || '').trim();
}

function getVideoDurationSeconds(media) {
    if (!media) return null;

    const variants = media.video_variants && typeof media.video_variants === 'object'
        ? media.video_variants
        : {};
    const rawDuration = variants.duration_seconds
        ?? variants.durationSeconds
        ?? variants.duration
        ?? media.duration_seconds
        ?? media.durationSeconds;

    return normalizeVideoDuration(rawDuration);
}

function getVideoDurationCacheSnapshot() {
    if (videoDurationCacheSnapshot) {
        return videoDurationCacheSnapshot;
    }

    try {
        const raw = localStorage.getItem(GALLERY_VIDEO_DURATION_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        videoDurationCacheSnapshot = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch (_error) {
        videoDurationCacheSnapshot = {};
    }

    return videoDurationCacheSnapshot;
}

function readCachedVideoDurationSeconds(media) {
    const cacheId = getVideoDurationCacheId(media);
    if (!cacheId) return null;

    const cached = getVideoDurationCacheSnapshot()[cacheId];
    const rawDuration = cached && typeof cached === 'object'
        ? cached.duration_seconds ?? cached.durationSeconds ?? cached.duration
        : cached;

    return normalizeVideoDuration(rawDuration);
}

function writeCachedVideoDurationSeconds(media, duration) {
    const cacheId = getVideoDurationCacheId(media);
    const normalizedDuration = normalizeVideoDuration(duration);
    if (!cacheId || !normalizedDuration) return;

    const snapshot = {
        ...getVideoDurationCacheSnapshot(),
        [cacheId]: {
            duration_seconds: normalizedDuration,
            cached_at: Date.now()
        }
    };
    const trimmedEntries = Object.entries(snapshot)
        .sort((left, right) => {
            const leftTime = Number(left[1]?.cached_at) || 0;
            const rightTime = Number(right[1]?.cached_at) || 0;
            return rightTime - leftTime;
        })
        .slice(0, GALLERY_VIDEO_DURATION_CACHE_LIMIT);

    videoDurationCacheSnapshot = Object.fromEntries(trimmedEntries);

    try {
        localStorage.setItem(GALLERY_VIDEO_DURATION_CACHE_KEY, JSON.stringify(videoDurationCacheSnapshot));
    } catch (_error) {
        null;
    }
}

function getKnownVideoDurationSeconds(media) {
    return getVideoDurationSeconds(media) || readCachedVideoDurationSeconds(media);
}

function formatVideoDurationValue(duration) {
    const normalizedDuration = normalizeVideoDuration(duration);
    if (!normalizedDuration) return '';

    const totalSeconds = Math.max(1, Math.round(normalizedDuration));
    if (totalSeconds < 60) {
        return `${totalSeconds} sec${totalSeconds === 1 ? '' : 's'}`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatVideoDurationLabel(media) {
    return formatVideoDurationValue(getKnownVideoDurationSeconds(media));
}

function isSupportedMediaFile(file) {
    const type = String(file?.type || '').toLowerCase();
    return type.startsWith('image/') || type.startsWith('video/') || VIDEO_EXTENSIONS.has(getMediaExtension(file));
}

function getMediaContentType(file) {
    const type = String(file?.type || '').trim().toLowerCase();
    if (type) return type;
    return isVideoMedia(file) ? 'video/mp4' : 'image/jpeg';
}

async function getResumableUploadHeaders(client, signedToken) {
    const sessionResult = typeof client?.auth?.getSession === 'function'
        ? await client.auth.getSession()
        : { data: { session: null } };
    const accessToken = sessionResult?.data?.session?.access_token || SUPABASE_KEY;

    return {
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_KEY,
        'x-signature': signedToken,
        'x-upsert': 'false'
    };
}

function normalizeUploadError(error, file) {
    const baseMessage = String(error?.message || error || 'The upload did not finish. Please try again.');

    if (/instance of Buffer or Readable/i.test(baseMessage)) {
        return new Error(
            `${file.name} could not start uploading because the browser loaded the wrong resumable uploader build. Refresh the page and try again.`
        );
    }

    if (/Invalid Compact JWS|AccessDenied|Unauthorized/i.test(baseMessage)) {
        return new Error(
            `${file.name} was rejected by Supabase Storage during the upload handshake. Refresh the page and try again. If it keeps failing, the signed upload token or upload auth headers are outdated.`
        );
    }

    if (/mime type .* is not supported/i.test(baseMessage)) {
        return new Error(
            `${file.name} is blocked by the storage bucket settings. Run the updated gallery SQL so ${getMediaContentType(file)} uploads are allowed.`
        );
    }

    if (/file size limit|entity too large|payload too large|maximum allowed size/i.test(baseMessage)) {
        return new Error(
            `${file.name} is larger than the current storage bucket limit. Run the updated gallery SQL to raise the bucket limit to ${MAX_UPLOAD_MB}MB.`
        );
    }

    return error instanceof Error ? error : new Error(baseMessage);
}

function getMediaKindLabel(value) {
    return isVideoMedia(value) ? 'Video' : 'Image';
}

function getPhotoUrl(client, photo) {
    if (!client || !photo?.storage_path) return '';
    const { data } = client.storage.from(photo.bucket_name || GALLERY_BUCKET).getPublicUrl(photo.storage_path);
    return data?.publicUrl || '';
}

function getStoragePublicUrl(client, bucketName, storagePath) {
    if (!client || !storagePath) return '';
    if (/^https?:\/\//i.test(storagePath)) return storagePath;

    const { data } = client.storage.from(bucketName || GALLERY_BUCKET).getPublicUrl(storagePath);
    return data?.publicUrl || '';
}

function getPhotoPosterUrl(client, photo) {
    return getStoragePublicUrl(client, photo?.bucket_name || GALLERY_BUCKET, photo?.poster_storage_path);
}

function getPhotoOwner(photo) {
    if (!photo) return 'Unknown uploader';
    if (photo.owner_name) return photo.owner_name;
    if (photo.first_name || photo.last_name) {
        return [photo.first_name, photo.last_name].filter(Boolean).join(' ').trim() || 'Unknown uploader';
    }
    if (photo.owner_username) return photo.owner_username;
    if (photo.username) return photo.username;
    return 'Unknown uploader';
}

function getPhotoTitle(photo) {
    const caption = safeCaption(photo?.caption);
    if (caption) return caption;
    return formatCompactDate(getPhotoTimestamp(photo));
}

function getCompactPhotoTitle(photo, maxLength = 34) {
    const title = getPhotoTitle(photo);
    return truncateText(title, maxLength);
}

function getPhotoTimestamp(photo) {
    return photo?.created_at || photo?.taken_at || null;
}

function getPhotoShape(photo, index = 0) {
    const width = Number(photo?.width) || 1;
    const height = Number(photo?.height) || 1;
    const ratio = width / height;

    if (ratio > 1.45 && index % 4 !== 1) return 'wide';
    if (ratio > 1.18) return 'landscape';
    if (ratio < 0.8 && index % 5 !== 0) return 'tall';
    return 'standard';
}

function getPhotoOrientation(photo) {
    const width = Number(photo?.width) || 1;
    const height = Number(photo?.height) || 1;
    const ratio = width / height;

    if (ratio < 0.86) return 'portrait';
    if (ratio > 1.14) return 'landscape';
    return 'square';
}

function deriveSearchText(photo) {
    return [
        photo.caption,
        photo.owner_name,
        photo.owner_username,
        formatMonthLabel(getPhotoTimestamp(photo)),
        formatCompactDate(getPhotoTimestamp(photo))
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function enrichPhoto(client, photo) {
    return {
        ...photo,
        publicUrl: getPhotoUrl(client, photo),
        posterUrl: getPhotoPosterUrl(client, photo),
        searchText: deriveSearchText(photo)
    };
}

function mergePhotoLists(primaryPhotos, secondaryPhotos = []) {
    const merged = new Map();

    [...primaryPhotos, ...secondaryPhotos].forEach((photo) => {
        const key = photo?.id || photo?.storage_path;
        if (!key || merged.has(key)) return;
        merged.set(key, photo);
    });

    return [...merged.values()].sort((left, right) => {
        const leftTime = new Date(getPhotoTimestamp(left) || 0).getTime();
        const rightTime = new Date(getPhotoTimestamp(right) || 0).getTime();
        return rightTime - leftTime;
    });
}

function getPhotoSurfaceStyle(photo) {
    const width = Number(photo?.width);
    const height = Number(photo?.height);
    const hasRatio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

    return {
        '--photo-bg': photo?.dominant_color || '#efe7dc',
        '--photo-ratio': hasRatio ? `${width} / ${height}` : '16 / 9'
    };
}

async function readImageDetails(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            let dominantColor = '#f3a46c';

            try {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d', { willReadFrequently: true });
                canvas.width = 16;
                canvas.height = 16;

                if (context) {
                    context.drawImage(img, 0, 0, 16, 16);
                    const pixels = context.getImageData(0, 0, 16, 16).data;
                    let red = 0;
                    let green = 0;
                    let blue = 0;
                    let count = 0;

                    for (let index = 0; index < pixels.length; index += 4) {
                        const alpha = pixels[index + 3];
                        if (alpha < 120) continue;
                        red += pixels[index];
                        green += pixels[index + 1];
                        blue += pixels[index + 2];
                        count += 1;
                    }

                    if (count > 0) {
                        dominantColor = `#${[red, green, blue]
                            .map((value) => clamp(Math.round(value / count), 0, 255).toString(16).padStart(2, '0'))
                            .join('')}`;
                    }
                }
            } catch (_error) {
                dominantColor = '#f3a46c';
            }

            URL.revokeObjectURL(url);
            resolve({
                width: img.naturalWidth,
                height: img.naturalHeight,
                dominantColor
            });
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Unable to read image metadata for ${file.name}.`));
        };

        img.src = url;
    });
}

async function readVideoDetails(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');

        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;

        video.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve({
                width: video.videoWidth || null,
                height: video.videoHeight || null,
                durationSeconds: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
                dominantColor: '#1d2638'
            });
        };

        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Unable to read video metadata for ${file.name}.`));
        };

        video.src = url;
    });
}

function buildPosterStoragePath(storagePath) {
    const withoutExtension = String(storagePath || 'video').replace(/\.[a-z0-9]+$/i, '');
    return `${withoutExtension}-poster.jpg`;
}

async function createVideoPosterBlob(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        let settled = false;

        const cleanup = () => {
            URL.revokeObjectURL(url);
            video.removeAttribute('src');
            video.load();
        };

        const finish = () => {
            if (settled) return;

            try {
                const sourceWidth = video.videoWidth || 640;
                const sourceHeight = video.videoHeight || 360;
                const scale = Math.min(1, 720 / Math.max(sourceWidth, sourceHeight));
                const width = Math.max(1, Math.round(sourceWidth * scale));
                const height = Math.max(1, Math.round(sourceHeight * scale));
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');

                canvas.width = width;
                canvas.height = height;

                if (!context) {
                    cleanup();
                    reject(new Error('Unable to prepare video thumbnail.'));
                    return;
                }

                context.drawImage(video, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    cleanup();
                    if (!blob) {
                        reject(new Error('Unable to prepare video thumbnail.'));
                        return;
                    }

                    resolve(blob);
                }, 'image/jpeg', 0.78);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };

        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.onloadedmetadata = () => {
            const seekTarget = Number.isFinite(video.duration) && video.duration > 1 ? 1 : 0;
            if (Number.isFinite(seekTarget) && seekTarget > 0 && video.duration > seekTarget) {
                video.currentTime = seekTarget;
            } else {
                finish();
            }
        };
        video.onseeked = finish;
        video.onloadeddata = () => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) {
                finish();
            }
        };
        video.onerror = () => {
            cleanup();
            reject(new Error(`Unable to prepare a thumbnail for ${file.name}.`));
        };
        video.src = url;
    });
}

async function uploadVideoPoster(client, storagePath, file) {
    if (!isVideoMedia(file)) return null;

    try {
        const posterPath = buildPosterStoragePath(storagePath);
        const posterBlob = await createVideoPosterBlob(file);
        const result = await client.storage.from(GALLERY_BUCKET).upload(posterPath, posterBlob, {
            contentType: 'image/jpeg',
            cacheControl: String(GALLERY_OBJECT_CACHE_CONTROL_SECONDS),
            upsert: false
        });

        if (result.error) {
            console.warn('Video thumbnail upload failed:', result.error.message);
            return null;
        }

        return posterPath;
    } catch (error) {
        console.warn('Video thumbnail generation failed:', error?.message || error);
        return null;
    }
}

async function readMediaDetails(file) {
    if (isVideoMedia(file)) {
        return readVideoDetails(file);
    }

    return readImageDetails(file);
}

async function readMediaDetailsSafe(file) {
    try {
        return await readMediaDetails(file);
    } catch (_error) {
        return {
            width: null,
            height: null,
            dominantColor: isVideoMedia(file) ? '#1d2638' : '#f3a46c'
        };
    }
}

async function uploadFileResumable(client, storagePath, file, { onProgress } = {}) {
    const signedUpload = await client.storage.from(GALLERY_BUCKET).createSignedUploadUrl(storagePath);
    if (signedUpload.error) throw signedUpload.error;
    if (!signedUpload.data?.token) {
        throw new Error('Supabase did not return a resumable upload token for this file.');
    }

    const uploadHeaders = await getResumableUploadHeaders(client, signedUpload.data.token);

    return new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
            endpoint: RESUMABLE_UPLOAD_ENDPOINT,
            retryDelays: RESUMABLE_UPLOAD_RETRY_DELAYS,
            headers: uploadHeaders,
            metadata: {
                bucketName: GALLERY_BUCKET,
                objectName: storagePath,
                contentType: getMediaContentType(file),
                cacheControl: String(GALLERY_OBJECT_CACHE_CONTROL_SECONDS)
            },
            chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES,
            uploadDataDuringCreation: true,
            removeFingerprintOnSuccess: true,
            onError(error) {
                reject(normalizeUploadError(error, file));
            },
            onProgress(bytesUploaded, bytesTotal) {
                onProgress?.(bytesUploaded, bytesTotal);
            },
            onSuccess() {
                resolve({
                    path: storagePath,
                    fullPath: `${GALLERY_BUCKET}/${storagePath}`
                });
            }
        });

        upload.start();
    });
}

async function listGalleryPhotos(client, { limit = getGalleryMetadataPageSize(), offset = 0 } = {}) {
    const pageLimit = clamp(Number(limit) || getGalleryMetadataPageSize(), 1, 500);
    const pageOffset = Math.max(0, Number(offset) || 0);
    const rpcResult = await client.rpc('gallery_list_photos', {
        p_limit: pageLimit,
        p_offset: pageOffset
    });

    if (!rpcResult.error) {
        return rpcResult.data || [];
    }

    const direct = await client
        .from('gallery_photos')
        .select('id, owner_user_id, bucket_name, storage_path, poster_storage_path, video_variants, caption, taken_at, width, height, dominant_color, is_featured, created_at')
        .is('archived_at', null)
        .order('taken_at', { ascending: false })
        .order('created_at', { ascending: false })
        .range(pageOffset, pageOffset + pageLimit - 1);

    if (!direct.error) {
        return direct.data || [];
    }

    const legacyDirect = await client
        .from('gallery_photos')
        .select('id, owner_user_id, bucket_name, storage_path, caption, taken_at, width, height, dominant_color, is_featured, created_at')
        .is('archived_at', null)
        .order('taken_at', { ascending: false })
        .order('created_at', { ascending: false })
        .range(pageOffset, pageOffset + pageLimit - 1);

    if (!legacyDirect.error) {
        return legacyDirect.data || [];
    }

    throw rpcResult.error || direct.error || legacyDirect.error;
}

async function createGalleryPhoto(client, payload) {
    const rpcResult = await client.rpc('gallery_create_photo', payload);
    if (!rpcResult.error) {
        return rpcResult.data;
    }

    const message = String(rpcResult.error?.message || '');
    if (!/gallery_create_photo|function/i.test(message)) {
        throw rpcResult.error;
    }

    if ('p_poster_storage_path' in payload || 'p_video_variants' in payload) {
        const legacyPayload = { ...payload };
        delete legacyPayload.p_poster_storage_path;
        delete legacyPayload.p_video_variants;

        const legacyRpcResult = await client.rpc('gallery_create_photo', legacyPayload);
        if (!legacyRpcResult.error) {
            return legacyRpcResult.data;
        }
    }

    const fallback = await client
        .from('gallery_photos')
        .insert({
            owner_user_id: payload.p_actor_user_id,
            bucket_name: payload.p_bucket_name,
            storage_path: payload.p_storage_path,
            poster_storage_path: payload.p_poster_storage_path || null,
            video_variants: payload.p_video_variants || {},
            caption: payload.p_caption,
            taken_at: payload.p_taken_at,
            width: payload.p_width,
            height: payload.p_height,
            dominant_color: payload.p_dominant_color
        })
        .select('id')
        .single();

    if (fallback.error && /poster_storage_path|video_variants|schema cache|column/i.test(String(fallback.error.message || ''))) {
        const legacyFallback = await client
            .from('gallery_photos')
            .insert({
                owner_user_id: payload.p_actor_user_id,
                bucket_name: payload.p_bucket_name,
                storage_path: payload.p_storage_path,
                caption: payload.p_caption,
                taken_at: payload.p_taken_at,
                width: payload.p_width,
                height: payload.p_height,
                dominant_color: payload.p_dominant_color
            })
            .select('id')
            .single();

        if (legacyFallback.error) throw legacyFallback.error;
        return legacyFallback.data?.id || null;
    }

    if (fallback.error) throw fallback.error;
    return fallback.data?.id || null;
}

async function deleteGalleryPhoto(client, actorUserId, photo) {
    if (!photo?.id) return;

    const rpcResult = await client.rpc('gallery_delete_photo', {
        p_actor_user_id: actorUserId,
        p_photo_id: photo.id
    });

    if (rpcResult.error && !/gallery_delete_photo|function/i.test(String(rpcResult.error.message || ''))) {
        throw rpcResult.error;
    }

    if (rpcResult.error) {
        const fallback = await client
            .from('gallery_photos')
            .delete()
            .eq('id', photo.id);

        if (fallback.error) throw fallback.error;
    }

    const storagePaths = [photo.storage_path, photo.poster_storage_path].filter(Boolean);
    if (storagePaths.length) {
        const removeResult = await client.storage
            .from(photo.bucket_name || GALLERY_BUCKET)
            .remove(storagePaths);

        if (removeResult.error) {
            console.warn('Photo metadata removed but storage cleanup failed:', removeResult.error.message);
        }
    }
}

async function setGalleryPhotoFeatured(client, actorUserId, photoId, isFeatured) {
    if (!photoId) return;

    const rpcResult = await client.rpc('gallery_set_photo_featured', {
        p_actor_user_id: actorUserId,
        p_photo_id: photoId,
        p_is_featured: isFeatured
    });

    if (!rpcResult.error) {
        return true;
    }

    const message = String(rpcResult.error?.message || '');
    if (/gallery_set_photo_featured|function/i.test(message)) {
        throw new Error('Run the updated gallery SQL to enable slideshow pinning.');
    }

    throw rpcResult.error;
}

function getPhotoDownloadName(photo) {
    const extension = getMediaExtension(photo) || (isVideoMedia(photo) ? 'mp4' : 'jpg');
    return `${sanitizeFileName(getPhotoTitle(photo) || 'gallery-item')}.${extension}`;
}

async function downloadGalleryPhoto(client, photo) {
    if (!photo) return;

    let blob = null;

    if (photo.storage_path && client?.storage) {
        const result = await client.storage
            .from(photo.bucket_name || GALLERY_BUCKET)
            .download(photo.storage_path);

        if (result.error) {
            throw result.error;
        }

        blob = result.data || null;
    }

    if (!blob && photo.publicUrl) {
        const response = await fetch(photo.publicUrl);
        if (!response.ok) {
            throw new Error('Unable to download this file right now.');
        }
        blob = await response.blob();
    }

    if (!blob) {
        throw new Error('Unable to prepare this file for download.');
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = getPhotoDownloadName(photo);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function buildDaySections(photos) {
    const sections = [];
    const map = new Map();

    photos.forEach((photo) => {
        const timestamp = getPhotoTimestamp(photo) || Date.now();
        const key = getDayKey(timestamp);
        if (!map.has(key)) {
            map.set(key, {
                key,
                title: getDayHeading(timestamp),
                subtitle: formatDisplayDate(timestamp),
                photos: []
            });
            sections.push(map.get(key));
        }
        map.get(key).photos.push(photo);
    });

    return sections;
}

function buildMonthSections(photos) {
    const sections = [];
    const map = new Map();

    photos.forEach((photo) => {
        const date = new Date(getPhotoTimestamp(photo) || Date.now());
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        if (!map.has(key)) {
            map.set(key, {
                key,
                title: formatMonthLabel(date),
                photos: []
            });
            sections.push(map.get(key));
        }

        map.get(key).photos.push(photo);
    });

    return sections;
}

function getSlideshowPhotos(photos, mediaFilter = 'videos', orderMode = 'latest', seed = 0, limit = 5) {
    const filtered = photos.filter((photo) => {
        if (mediaFilter === 'images') return !isVideoMedia(photo);
        if (mediaFilter === 'videos') return isVideoMedia(photo);
        return true;
    });

    const scoped = orderMode === 'pinned'
        ? filtered.filter((photo) => Boolean(photo.is_featured))
        : filtered;

    if (orderMode === 'pinned' || orderMode === 'latest') {
        return scoped.slice(0, Math.min(limit, scoped.length));
    }

    return [...scoped]
        .sort((left, right) => {
            const leftKey = hashValue(`${seed}:${left.id || left.storage_path}`);
            const rightKey = hashValue(`${seed}:${right.id || right.storage_path}`);
            return leftKey - rightKey;
        })
        .slice(0, Math.min(limit, scoped.length));
}

function getSlideshowLabel(orderMode = 'latest', mediaFilter = 'videos') {
    const prefix = orderMode === 'shuffle'
        ? 'Shuffle'
        : orderMode === 'pinned'
            ? 'Pinned'
            : 'Recent';

    if (mediaFilter === 'videos') return `${prefix} Video`;
    if (mediaFilter === 'images') return `${prefix} Image`;
    return `${prefix} Highlight`;
}

function Icon({ path, size = 20, strokeWidth = 1.8 }) {
    return html`
        <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d=${path} stroke="currentColor" stroke-width=${strokeWidth} stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
}

function probeVideoDuration(media) {
    if (!media?.publicUrl || typeof document === 'undefined') {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const video = document.createElement('video');
        let settled = false;
        const timeoutId = setTimeout(() => finish(null), VIDEO_DURATION_PROBE_TIMEOUT_MS);

        const cleanup = () => {
            clearTimeout(timeoutId);

            try {
                video.pause();
                video.removeAttribute('src');
                video.load();
            } catch (_error) {
                null;
            }
        };

        const finish = (duration) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(normalizeVideoDuration(duration));
        };

        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.onloadedmetadata = () => finish(video.duration);
        video.onerror = () => finish(null);
        video.src = media.publicUrl;

        try {
            video.load();
        } catch (_error) {
            finish(null);
        }
    });
}

function flushVideoDurationProbeQueue() {
    while (videoDurationProbeActiveCount < VIDEO_DURATION_PROBE_CONCURRENCY && videoDurationProbeQueue.length) {
        const task = videoDurationProbeQueue.shift();
        videoDurationProbeActiveCount += 1;

        probeVideoDuration(task.media)
            .then((duration) => {
                if (duration) {
                    writeCachedVideoDurationSeconds(task.media, duration);
                }

                task.resolve(duration);
            })
            .catch(() => task.resolve(null))
            .finally(() => {
                videoDurationProbeActiveCount = Math.max(0, videoDurationProbeActiveCount - 1);
                flushVideoDurationProbeQueue();
            });
    }
}

function scheduleVideoDurationProbe(media) {
    const knownDuration = getKnownVideoDurationSeconds(media);
    if (knownDuration) {
        return Promise.resolve(knownDuration);
    }

    const cacheId = getVideoDurationCacheId(media);
    if (!cacheId || !isVideoMedia(media) || !media?.publicUrl) {
        return Promise.resolve(null);
    }

    if (videoDurationProbePending.has(cacheId)) {
        return videoDurationProbePending.get(cacheId);
    }

    const scheduledProbe = new Promise((resolve) => {
        videoDurationProbeQueue.push({ media, resolve });
        flushVideoDurationProbeQueue();
    });
    const trackedProbe = scheduledProbe.finally(() => {
        videoDurationProbePending.delete(cacheId);
    });

    videoDurationProbePending.set(cacheId, trackedProbe);
    return trackedProbe;
}

function useVideoDurationLabel(media, enabled = true) {
    const isEnabledVideo = Boolean(enabled && isVideoMedia(media));
    const cacheId = getVideoDurationCacheId(media);
    const badgeRef = useRef(null);
    const [duration, setDuration] = useState(() => (
        isEnabledVideo ? getKnownVideoDurationSeconds(media) : null
    ));
    const [isNearViewport, setIsNearViewport] = useState(false);

    useEffect(() => {
        setDuration(isEnabledVideo ? getKnownVideoDurationSeconds(media) : null);
        setIsNearViewport(false);
    }, [cacheId, isEnabledVideo, media?.publicUrl]);

    useEffect(() => {
        if (!isEnabledVideo || duration || !media?.publicUrl || isConstrainedGalleryDevice()) {
            return undefined;
        }

        const node = badgeRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') {
            setIsNearViewport(true);
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
                setIsNearViewport(true);
                observer.disconnect();
            }
        }, {
            rootMargin: isConstrainedGalleryDevice() ? GALLERY_CONSTRAINED_MEDIA_ROOT_MARGIN : VIDEO_DURATION_ROOT_MARGIN
        });

        observer.observe(node);

        return () => observer.disconnect();
    }, [cacheId, duration, isEnabledVideo, media?.publicUrl]);

    useEffect(() => {
        if (!isEnabledVideo || duration || !isNearViewport || !media?.publicUrl || isConstrainedGalleryDevice()) {
            return undefined;
        }

        let cancelled = false;

        scheduleVideoDurationProbe(media).then((nextDuration) => {
            if (!cancelled && nextDuration) {
                setDuration(nextDuration);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [cacheId, duration, isEnabledVideo, isNearViewport, media?.publicUrl]);

    return {
        badgeRef,
        durationLabel: formatVideoDurationValue(duration)
    };
}

function MediaBadge({ media, tone = 'default' }) {
    const isVideo = isVideoMedia(media);
    const { badgeRef, durationLabel } = useVideoDurationLabel(media, isVideo);

    if (!isVideo) return null;

    return html`
        <span
            ref=${badgeRef}
            className=${cx('gallery-media-badge', durationLabel && 'has-duration', tone !== 'default' && `is-${tone}`)}>
            <span>Video</span>
            ${durationLabel ? html`<span className="gallery-media-duration">${durationLabel}</span>` : null}
        </span>
    `;
}

function useCachedMediaUrl(sourceUrl, enabled, cacheKey = sourceUrl) {
    const [resolvedUrl, setResolvedUrl] = useState('');

    useEffect(() => {
        let cancelled = false;
        let objectUrl = '';

        setResolvedUrl('');

        if (!sourceUrl || !enabled) {
            return undefined;
        }

        if (isConstrainedGalleryDevice()) {
            setResolvedUrl(sourceUrl);
            return undefined;
        }

        if (!canUseCacheStorage()) {
            setResolvedUrl(sourceUrl);
            return undefined;
        }

        const loadMedia = async () => {
            try {
                const cachedUrl = await readCachedBlobUrl(cacheKey);
                if (cachedUrl) {
                    if (cancelled) {
                        URL.revokeObjectURL(cachedUrl);
                        return;
                    }

                    objectUrl = cachedUrl;
                    setResolvedUrl(cachedUrl);
                    return;
                }

                const blob = await scheduleMediaCacheFetch(sourceUrl, cacheKey);

                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setResolvedUrl(objectUrl);
            } catch (_error) {
                if (!cancelled) {
                    setResolvedUrl(sourceUrl);
                }
            }
        };

        loadMedia();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [cacheKey, enabled, sourceUrl]);

    return resolvedUrl;
}

function useCachedPlaybackUrl(sourceUrl, enabled, cacheKey = sourceUrl) {
    const [cachedUrl, setCachedUrl] = useState('');

    useEffect(() => {
        let cancelled = false;
        let objectUrl = '';

        setCachedUrl('');

        if (!sourceUrl || !enabled || isConstrainedGalleryDevice() || !canUseCacheStorage()) {
            return undefined;
        }

        const loadCachedPlayback = async () => {
            try {
                const nextCachedUrl = await readCachedBlobUrl(cacheKey);
                if (!nextCachedUrl) return;

                if (cancelled) {
                    URL.revokeObjectURL(nextCachedUrl);
                    return;
                }

                objectUrl = nextCachedUrl;
                setCachedUrl(nextCachedUrl);
            } catch (_error) {
                null;
            }
        };

        loadCachedPlayback();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [cacheKey, enabled, sourceUrl]);

    return cachedUrl;
}

function queueVideoPlaybackCache(media, queuedRef) {
    if (!media?.publicUrl || !isVideoMedia(media)) return;
    if (isConstrainedGalleryDevice()) return;
    if (queuedRef?.current) return;

    if (queuedRef) {
        queuedRef.current = true;
    }

    scheduleMediaCacheFetch(media.publicUrl, media.publicUrl).catch((error) => {
        console.warn('Video playback cache failed:', error?.message || error);
    });
}

function useGeneratedVideoPosterUrl(media, enabled) {
    const [posterUrl, setPosterUrl] = useState('');

    useEffect(() => {
        let cancelled = false;
        let objectUrl = '';

        setPosterUrl(enabled ? null : '');

        if (!enabled || !media?.publicUrl) {
            return undefined;
        }

        const cacheKey = getGeneratedPosterCacheUrl(media);

        const loadPoster = async () => {
            try {
                const cachedUrl = await readCachedBlobUrl(cacheKey);
                if (cachedUrl) {
                    if (cancelled) {
                        URL.revokeObjectURL(cachedUrl);
                        return;
                    }

                    objectUrl = cachedUrl;
                    setPosterUrl(cachedUrl);
                    return;
                }

                if (!cancelled) {
                    setPosterUrl('');
                }
            } catch (_error) {
                if (!cancelled) {
                    setPosterUrl('');
                }
            }
        };

        loadPoster();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [enabled, media?.id, media?.publicUrl, media?.storage_path]);

    return posterUrl;
}

function MediaSurface({
    media,
    className,
    alt = '',
    decorative = false,
    lazy = true,
    playVideo = false,
    autoPlay = false,
    attemptPlayback = false,
    suspendPlayback = false,
    muted = true,
    loop = false,
    controls = false,
    preload = 'metadata',
    framePreview = false,
    generatePoster = false,
    onReady = null,
    onAutoplayMuted = null,
    onEnded = null
}) {
    const hasPublicUrl = Boolean(media?.publicUrl);
    const isVideo = hasPublicUrl && isVideoMedia(media);
    const shouldRenderVideo = isVideo && playVideo;
    const mediaRef = useRef(null);
    const videoPlaybackCacheQueuedRef = useRef(false);
    const [isNearViewport, setIsNearViewport] = useState(() => !lazy);
    const shouldLoadMedia = hasPublicUrl && (!lazy || isNearViewport);
    const cachedImageUrl = useCachedMediaUrl(media?.publicUrl, shouldLoadMedia && !isVideo, media?.publicUrl);
    const cachedPosterUrl = useCachedMediaUrl(media?.posterUrl, shouldLoadMedia && isVideo && !playVideo && Boolean(media?.posterUrl), media?.posterUrl);
    const generatedPosterUrl = useGeneratedVideoPosterUrl(media, shouldLoadMedia && isVideo && !playVideo && !media?.posterUrl && generatePoster);
    const cachedPlaybackUrl = useCachedPlaybackUrl(media?.publicUrl, shouldRenderVideo && shouldLoadMedia, media?.publicUrl);
    const videoPosterUrl = media?.posterUrl ? cachedPosterUrl : generatedPosterUrl;
    const playbackUrl = cachedPlaybackUrl || media?.publicUrl;
    const allowFramePreview = Boolean(framePreview && !isConstrainedGalleryDevice());
    const renderVideoPreview = (posterUrl = '', extraClassName = '', includeFrame = false) => html`
        <span
            ref=${mediaRef}
            className=${cx(className, 'is-video-preview', posterUrl ? 'has-poster' : 'is-video-placeholder', includeFrame && !posterUrl && 'has-frame-preview', extraClassName)}
            style=${posterUrl ? { '--video-poster-url': `url("${posterUrl}")` } : undefined}
            role=${decorative ? undefined : 'img'}
            aria-hidden=${decorative ? 'true' : undefined}
            aria-label=${decorative ? undefined : alt}>
            ${posterUrl
                ? html`
                      <img
                          className="gallery-video-poster-image"
                          src=${posterUrl}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          decoding="async" />
                  `
                : null}
            ${!posterUrl && includeFrame
                ? html`
                          <video
                              className="gallery-video-preview-frame"
                              src=${media.publicUrl}
                              crossOrigin="anonymous"
                              muted=${true}
                              playsInline=${true}
                              preload="metadata"
                          aria-hidden="true"
                          tabIndex="-1"
                          onLoadedMetadata=${(event) => {
                              const video = event.currentTarget;
                              const targetTime = Number.isFinite(video.duration) && video.duration > 1
                                  ? 1
                                  : 0;

                              try {
                                  if (Math.abs(video.currentTime - targetTime) > 0.05) {
                                      video.currentTime = targetTime;
                                  }
                              } catch (_error) {
                                  null;
                              }
                          }}
                          onLoadedData=${(event) => {
                              event.currentTarget.pause();
                              onReady?.(event);
                          }}></video>
                  `
                : null}
        </span>
    `;

    useEffect(() => {
        setIsNearViewport(!lazy);
        videoPlaybackCacheQueuedRef.current = false;
    }, [lazy, media?.publicUrl]);

    useEffect(() => {
        if (!hasPublicUrl || !lazy || isNearViewport) {
            return undefined;
        }

        const node = mediaRef.current;
        if (!node) {
            return undefined;
        }

        if (typeof IntersectionObserver === 'undefined') {
            setIsNearViewport(true);
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
                setIsNearViewport(true);
                observer.disconnect();
            }
        }, {
            rootMargin: getGalleryMediaRootMargin()
        });

        observer.observe(node);

        return () => observer.disconnect();
    }, [hasPublicUrl, isNearViewport, lazy, media?.publicUrl]);

    useEffect(() => {
        if (!shouldRenderVideo || !shouldLoadMedia) {
            return undefined;
        }

        const video = mediaRef.current;
        if (!video) {
            return undefined;
        }

        video.defaultMuted = muted;
        video.muted = muted;

        if (suspendPlayback) {
            video.pause();
        }

        return undefined;
    }, [shouldRenderVideo, muted, shouldLoadMedia, suspendPlayback, media?.publicUrl]);

    useEffect(() => {
        if (!shouldRenderVideo || !shouldLoadMedia || !attemptPlayback || !autoPlay || suspendPlayback) {
            return undefined;
        }

        const video = mediaRef.current;
        if (!video) {
            return undefined;
        }

        let cancelled = false;

        const startPlayback = () => {
            if (cancelled) return;

            const playPromise = video.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch(() => {
                    if (cancelled || video.muted) {
                        return null;
                    }

                    video.defaultMuted = true;
                    video.muted = true;
                    onAutoplayMuted?.();

                    const mutedFallback = video.play();
                    if (mutedFallback && typeof mutedFallback.catch === 'function') {
                        mutedFallback.catch(() => null);
                    }

                    return null;
                });
            }
        };

        if (video.readyState >= 2) {
            startPlayback();
        }

        video.addEventListener('canplay', startPlayback);
        video.addEventListener('loadeddata', startPlayback);

        return () => {
            cancelled = true;
            video.removeEventListener('canplay', startPlayback);
            video.removeEventListener('loadeddata', startPlayback);

            if (!controls) {
                video.pause();
            }
        };
    }, [shouldRenderVideo, shouldLoadMedia, attemptPlayback, autoPlay, suspendPlayback, controls, media?.publicUrl, onAutoplayMuted]);

    if (!hasPublicUrl) {
        return null;
    }

    if (!shouldLoadMedia) {
        return html`
            <span
                ref=${mediaRef}
                className=${cx(className, 'is-media-deferred')}
                aria-hidden=${decorative ? 'true' : undefined}
                aria-label=${decorative ? undefined : alt}></span>
        `;
    }

    if (isVideo && !playVideo) {
        if (media.posterUrl && !cachedPosterUrl) {
            return renderVideoPreview('', 'is-video-poster-loading');
        }

        if (!media.posterUrl && generatePoster && generatedPosterUrl === null) {
            return renderVideoPreview('', 'is-video-poster-loading');
        }

        if (videoPosterUrl) {
            return renderVideoPreview(videoPosterUrl);
        }

        return renderVideoPreview('', '', allowFramePreview);
    }

    if (shouldRenderVideo) {
        const handlePlaybackProgress = (event) => {
            const video = event.currentTarget;
            const duration = Number(video.duration);
            if (!Number.isFinite(duration) || duration <= 0) return;

            if (video.currentTime / duration >= 0.82) {
                queueVideoPlaybackCache(media, videoPlaybackCacheQueuedRef);
            }
        };

        const handlePlaybackEnded = (event) => {
            queueVideoPlaybackCache(media, videoPlaybackCacheQueuedRef);
            onEnded?.(event);
        };

        return html`
            <video
                ref=${mediaRef}
                className=${className}
                src=${playbackUrl}
                playsInline=${true}
                muted=${muted}
                loop=${loop}
                autoPlay=${autoPlay}
                controls=${controls}
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture=${true}
                preload=${preload}
                aria-hidden=${decorative ? 'true' : undefined}
                aria-label=${decorative ? undefined : alt}
                onLoadedData=${onReady}
                onTimeUpdate=${handlePlaybackProgress}
                onEnded=${handlePlaybackEnded}></video>
        `;
    }

    if (!isVideo && !cachedImageUrl) {
        return html`
            <span
                ref=${mediaRef}
                className=${cx(className, 'is-media-deferred')}
                aria-hidden=${decorative ? 'true' : undefined}
                aria-label=${decorative ? undefined : alt}></span>
        `;
    }

    return html`
        <img
            ref=${mediaRef}
            className=${className}
            src=${cachedImageUrl}
            alt=${decorative ? '' : alt}
            aria-hidden=${decorative ? 'true' : undefined}
            loading="lazy"
            decoding="async"
            onLoad=${onReady} />
    `;
}

function Tile({ photo, index, onOpen }) {
    const isVideo = isVideoMedia(photo);
    const { revealRef, isRevealed } = useRevealOnScroll();

    return html`
        <button
            ref=${revealRef}
            type="button"
            className=${cx('gallery-tile gallery-reveal', isRevealed && 'is-visible', getPhotoShape(photo, index), isVideo && 'is-video-tile')}
            style=${{
                ...getPhotoSurfaceStyle(photo),
                '--gallery-reveal-delay': `${Math.min(index % 6, 5) * 42}ms`
            }}
            onClick=${() => onOpen(photo.id)}>
            <${MediaSurface}
                media=${photo}
                className="gallery-tile-media"
                alt=${getPhotoTitle(photo)}
                autoPlay=${false}
                muted=${true}
                loop=${true}
                preload="none"
                framePreview=${isVideo}
                generatePoster=${isVideo} />
            <${MediaBadge} media=${photo} />
            <div className="gallery-tile-overlay">
                <p className="gallery-tile-title">${getPhotoTitle(photo)}</p>
                <div className="gallery-tile-meta">
                    <span>${getPhotoOwner(photo)}</span>
                    <span>${formatCompactDate(getPhotoTimestamp(photo))}</span>
                </div>
            </div>
        </button>
    `;
}

function CompactTile({ photo, index = 0, onOpen }) {
    const isVideo = isVideoMedia(photo);
    const { revealRef, isRevealed } = useRevealOnScroll();

    return html`
        <button
            ref=${revealRef}
            type="button"
            className=${cx('gallery-tile gallery-tile-compact gallery-reveal', isRevealed && 'is-visible', isVideo && 'is-video-tile')}
            style=${{
                ...getPhotoSurfaceStyle(photo),
                '--gallery-reveal-delay': `${Math.min(index % 6, 5) * 36}ms`
            }}
            onClick=${() => onOpen(photo.id)}>
            <${MediaSurface}
                media=${photo}
                className="gallery-tile-media"
                alt=${getPhotoTitle(photo)}
                autoPlay=${false}
                muted=${true}
                loop=${true}
                preload="none"
                framePreview=${isVideo}
                generatePoster=${isVideo} />
            <${MediaBadge} media=${photo} />
            <div className="gallery-tile-overlay">
                <p className="gallery-tile-title">${getCompactPhotoTitle(photo)}</p>
                <div className="gallery-tile-meta">
                    <span>${getPhotoOwner(photo)}</span>
                    <span>${formatCompactDate(getPhotoTimestamp(photo))}</span>
                </div>
            </div>
        </button>
    `;
}

function PreviewGrid({ photos, onOpenPhoto, onOpenMore }) {
    const previewLimit = getSectionPreviewLimit();
    const hasMore = photos.length > previewLimit;
    const visiblePhotos = hasMore ? photos.slice(0, previewLimit - 1) : photos.slice(0, previewLimit);
    const remainingCount = Math.max(0, photos.length - visiblePhotos.length);
    const morePreviewPhoto = hasMore ? photos[visiblePhotos.length] || visiblePhotos[visiblePhotos.length - 1] || photos[0] : null;

    return html`
        <div className="gallery-grid gallery-grid-preview">
            ${visiblePhotos.map(
                (photo, index) => html`
                    <${CompactTile}
                        key=${photo.id}
                        photo=${photo}
                        index=${index}
                        onOpen=${onOpenPhoto} />
                `
            )}
            ${hasMore
                ? html`
                      <button
                          type="button"
                          className=${cx('gallery-tile gallery-preview-more', isVideoMedia(morePreviewPhoto) && 'is-video-tile')}
                          style=${morePreviewPhoto ? getPhotoSurfaceStyle(morePreviewPhoto) : undefined}
                          onClick=${onOpenMore}>
                          ${morePreviewPhoto
                              ? html`
                                    <${MediaSurface}
                                        media=${morePreviewPhoto}
                                        className="gallery-preview-more-media"
                                        decorative=${true}
                                        autoPlay=${false}
                                        muted=${true}
                                        loop=${true}
                                        preload="none"
                                        framePreview=${isVideoMedia(morePreviewPhoto)}
                                        generatePoster=${isVideoMedia(morePreviewPhoto)} />
                                `
                              : null}
                          <div className="gallery-preview-more-overlay">
                              <span className="gallery-preview-more-count">+${remainingCount}</span>
                              <span className="gallery-preview-more-label">View all</span>
                          </div>
                      </button>
                  `
                : null}
        </div>
    `;
}

function EmptyState({ currentUser, onUpload }) {
    return html`
        <div className="gallery-empty">
            <h3>No media yet</h3>
            <p>
                Add your first photo or video.
            </p>
            <div className="gallery-upload-actions" style=${{ justifyContent: 'center', marginTop: '0.85rem' }}>
                ${currentUser
                    ? html`<button type="button" className="gallery-button primary" onClick=${onUpload}>Upload</button>`
                    : html`<a href="billing.html" className="gallery-button primary">Sign in</a>`}
            </div>
        </div>
    `;
}

function SlideshowEmptyState({ mediaFilter, orderMode = 'latest', onReset }) {
    const mediaLabel = mediaFilter === 'videos'
        ? 'videos'
        : mediaFilter === 'images'
            ? 'images'
            : 'media';
    const isPinnedMode = orderMode === 'pinned';

    return html`
        <div className="gallery-empty gallery-slideshow-empty">
            <h3>${isPinnedMode ? `No pinned ${mediaLabel} yet` : `No ${mediaLabel} in the slideshow`}</h3>
            <p>
                ${isPinnedMode
                    ? 'Pin a photo or video from the viewer, or switch back to the latest feed.'
                    : `Switch the slideshow back to videos or upload more ${mediaLabel}.`}
            </p>
            <div className="gallery-upload-actions" style=${{ justifyContent: 'center', marginTop: '0.85rem' }}>
                <button type="button" className="gallery-button primary" onClick=${onReset}>
                    ${isPinnedMode ? 'Show latest' : 'Show all media'}
                </button>
            </div>
        </div>
    `;
}

function GalleryLoader({ label = 'Opening gallery' }) {
    return html`
        <div className="gallery-loader-screen" role="status" aria-live="polite" aria-label=${label}>
            <div className="gallery-loader-stack">
                <div className="gallery-loader-card">
                    <img src="lynmark-logo.png" alt="" className="gallery-loader-logo" />
                </div>
                <div className="gallery-loader-dots" aria-hidden="true">
                    <span className="gallery-loader-dot"></span>
                    <span className="gallery-loader-dot"></span>
                    <span className="gallery-loader-dot"></span>
                </div>
                <span className="gallery-visually-hidden">${label}</span>
            </div>
        </div>
    `;
}

function useRevealOnScroll(rootMargin = '0px 0px -8% 0px') {
    const revealRef = useRef(null);
    const [isRevealed, setIsRevealed] = useState(() => typeof IntersectionObserver === 'undefined');

    useEffect(() => {
        const node = revealRef.current;
        if (!node || isRevealed) {
            return undefined;
        }

        if (typeof IntersectionObserver === 'undefined') {
            setIsRevealed(true);
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
                setIsRevealed(true);
                observer.disconnect();
            }
        }, {
            rootMargin,
            threshold: 0.04
        });

        observer.observe(node);

        return () => observer.disconnect();
    }, [isRevealed, rootMargin]);

    return { revealRef, isRevealed };
}

function useScrollCooling(enabled = true) {
    const scrollTimeoutRef = useRef(null);
    const [isScrolling, setIsScrolling] = useState(false);

    useEffect(() => {
        if (!enabled || typeof window === 'undefined') {
            return undefined;
        }

        const onScroll = () => {
            setIsScrolling(true);

            if (scrollTimeoutRef.current) {
                window.clearTimeout(scrollTimeoutRef.current);
            }

            scrollTimeoutRef.current = window.setTimeout(() => {
                setIsScrolling(false);
            }, isConstrainedGalleryDevice() ? 360 : 180);
        };

        window.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            window.removeEventListener('scroll', onScroll);
            if (scrollTimeoutRef.current) {
                window.clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, [enabled]);

    return isScrolling;
}

function LoadMoreSentinel({ busy = false, disabled = false, label = 'Load more', busyLabel = 'Loading more...', onLoadMore }) {
    const sentinelRef = useRef(null);

    useEffect(() => {
        if (disabled || busy || !onLoadMore) {
            return undefined;
        }

        const node = sentinelRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') {
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
                onLoadMore();
            }
        }, {
            rootMargin: GALLERY_NEXT_PAGE_ROOT_MARGIN
        });

        observer.observe(node);

        return () => observer.disconnect();
    }, [busy, disabled, onLoadMore]);

    return html`
        <div className="gallery-load-more" ref=${sentinelRef}>
            <button
                type="button"
                className="gallery-button gallery-load-more-button"
                disabled=${disabled || busy}
                onClick=${onLoadMore}>
                ${busy ? busyLabel : label}
            </button>
        </div>
    `;
}

function HeroSlideshow({ photos, onOpen, orderMode = 'latest', mediaFilter = 'videos', pausePlayback = false }) {
    const photoSignature = `${orderMode}:${mediaFilter}:${photos.map((photo) => photo.id).join('|')}`;
    const activeSignatureRef = useRef(photoSignature);
    const [activeIndex, setActiveIndex] = useState(() => readSlideshowState(photoSignature, photos.length));
    const [videoMuted, setVideoMuted] = useState(false);
    const [activeVideoPlaying, setActiveVideoPlaying] = useState(false);

    useEffect(() => {
        if (!photos.length) return undefined;

        if (activeSignatureRef.current !== photoSignature) {
            const storedIndex = readSlideshowState(photoSignature, photos.length);
            activeSignatureRef.current = photoSignature;
            setActiveIndex(storedIndex);
            writeSlideshowState(photoSignature, storedIndex);
            return undefined;
        }

        const nextIndex = clamp(activeIndex, 0, photos.length - 1);
        if (nextIndex !== activeIndex) {
            setActiveIndex(nextIndex);
            return undefined;
        }

        writeSlideshowState(photoSignature, nextIndex);
        return undefined;
    }, [activeIndex, photoSignature, photos.length]);

    const activePhoto = photos[activeIndex] || photos[0] || null;
    const activeIsVideo = activePhoto ? isVideoMedia(activePhoto) : false;
    const shouldAutoplayActiveMedia = activeIsVideo && activeVideoPlaying;
    const activeMediaPreload = 'none';
    const slideshowLabel = getSlideshowLabel(orderMode, mediaFilter);
    const showSlideDots = photos.length > 1 && photos.length <= 20;
    const goTo = (index) => {
        setActiveVideoPlaying(false);
        setActiveIndex((index + photos.length) % photos.length);
    };

    useEffect(() => {
        if (pausePlayback) return undefined;
        if (photos.length < 2) return undefined;
        if (activeVideoPlaying) return undefined;

        const timerId = window.setTimeout(() => {
            setActiveIndex((current) => (current + 1) % photos.length);
        }, activeIsVideo ? 6200 : 4800);

        return () => window.clearTimeout(timerId);
    }, [activeIndex, activeIsVideo, activeVideoPlaying, photos.length, photoSignature, pausePlayback]);

    useEffect(() => {
        setVideoMuted(false);
        setActiveVideoPlaying(false);
    }, [activePhoto?.id]);

    if (!activePhoto) return null;

    const activeOrientation = getPhotoOrientation(activePhoto);

    return html`
        <div className="gallery-slideshow">
            <div className=${cx('gallery-slideshow-stage', `is-${activeOrientation}`, activeIsVideo && 'is-video')} style=${getPhotoSurfaceStyle(activePhoto)}>
                ${activeIsVideo
                    ? html`
                          <div
                              className=${cx('gallery-slideshow-media', `is-${activeOrientation}`, 'is-video', activeVideoPlaying && 'is-playing')}
                              onClick=${activeVideoPlaying ? undefined : () => setActiveVideoPlaying(true)}>
                              <${MediaSurface}
                                  key=${`${activePhoto.id || activeIndex}:${activeVideoPlaying ? 'player' : 'preview'}`}
                                  media=${activePhoto}
                                  className=${cx('gallery-slideshow-main', `is-${activeOrientation}`)}
                                  alt=${getPhotoTitle(activePhoto)}
                                  lazy=${false}
                                  playVideo=${activeVideoPlaying}
                                  autoPlay=${shouldAutoplayActiveMedia}
                                  attemptPlayback=${shouldAutoplayActiveMedia}
                                  suspendPlayback=${pausePlayback}
                                  muted=${videoMuted}
                                  loop=${false}
                                  controls=${activeVideoPlaying}
                                  preload=${activeMediaPreload}
                                  framePreview=${true}
                                  generatePoster=${true}
                                  onAutoplayMuted=${() => setVideoMuted(true)}
                                  onEnded=${photos.length > 1 ? () => goTo(activeIndex + 1) : () => setActiveVideoPlaying(false)} />
                              ${!activeVideoPlaying
                                  ? html`
                                        <button
                                            type="button"
                                            className="gallery-slideshow-play-button"
                                            aria-label="Play video"
                                            onClick=${(event) => {
                                                event.stopPropagation();
                                                setActiveVideoPlaying(true);
                                            }}>
                                            <span className="gallery-visually-hidden">Play video</span>
                                        </button>
                                    `
                                  : null}
                          </div>
                      `
                    : html`
                          <button
                              type="button"
                              className=${cx('gallery-slideshow-media', `is-${activeOrientation}`)}
                              onClick=${() => onOpen(activePhoto.id)}>
                              <${MediaSurface}
                                  media=${activePhoto}
                                  className="gallery-slideshow-backdrop"
                                  decorative=${true}
                                  lazy=${false}
                                  muted=${true}
                                  loop=${true}
                                  preload="metadata" />
                              <${MediaSurface}
                                  key=${activePhoto.id || activeIndex}
                                  media=${activePhoto}
                                  className=${cx('gallery-slideshow-main', `is-${activeOrientation}`)}
                                  alt=${getPhotoTitle(activePhoto)}
                                  lazy=${false}
                                  muted=${true}
                                  loop=${true}
                                  preload="metadata" />
                          </button>
                      `}
                ${photos.length > 1
                    ? html`
                          <button
                              type="button"
                              className="gallery-slideshow-nav is-prev"
                              aria-label="Previous highlight"
                              onClick=${() => goTo(activeIndex - 1)}>
                              ${html`<${Icon} path="M15 18l-6-6 6-6" size=${18} />`}
                          </button>
                          <button
                              type="button"
                              className="gallery-slideshow-nav is-next"
                              aria-label="Next highlight"
                              onClick=${() => goTo(activeIndex + 1)}>
                              ${html`<${Icon} path="M9 18l6-6-6-6" size=${18} />`}
                          </button>
                      `
                    : null}
            </div>
            <div className="gallery-slideshow-footer">
                <div className="gallery-slideshow-info">
                    <span className="gallery-mosaic-eyebrow">${slideshowLabel}</span>
                    <strong className="gallery-slideshow-title">${getPhotoTitle(activePhoto)}</strong>
                    <div className="gallery-slideshow-meta">
                        <span>${getPhotoOwner(activePhoto)} / ${formatCompactDate(getPhotoTimestamp(activePhoto))}</span>
                    </div>
                </div>
                <div className="gallery-slideshow-footer-controls">
                    ${showSlideDots
                        ? html`
                              <div className="gallery-slideshow-dots" role="tablist" aria-label="Highlight slides">
                                  ${photos.map(
                                      (photo, index) => html`
                                          <button
                                              type="button"
                                              key=${photo.id || index}
                                              className=${cx('gallery-slideshow-dot', index === activeIndex && 'is-active')}
                                              aria-label=${`Show slide ${index + 1}`}
                                              aria-pressed=${index === activeIndex ? 'true' : 'false'}
                                              onClick=${() => goTo(index)}></button>
                                      `
                                  )}
                              </div>
                          `
                        : null}
                    ${activeIsVideo && shouldAutoplayActiveMedia
                        ? html`
                              <button
                                  type="button"
                                  className=${cx('gallery-slideshow-audio', !videoMuted && 'is-active')}
                                  aria-label=${videoMuted ? 'Enable video sound' : 'Mute video sound'}
                                  aria-pressed=${!videoMuted ? 'true' : 'false'}
                                  onClick=${() => setVideoMuted((current) => !current)}>
                                  ${videoMuted
                                      ? html`<${Icon} path="M11 5 6 9H3v6h3l5 4V5Zm6.5 4.5-3 3m0-3 3 3" size=${15} />`
                                      : html`<${Icon} path="M11 5 6 9H3v6h3l5 4V5Zm4.5 2.5a5 5 0 0 1 0 9m-2-6.75a2.75 2.75 0 0 1 0 4.5" size=${15} />`}
                                  <span>${videoMuted ? 'Tap for sound' : 'Sound on'}</span>
                              </button>
                          `
                        : null}
                    ${photos.length > 1
                        ? html`<span className="gallery-slideshow-count">${activeIndex + 1} / ${photos.length}</span>`
                        : null}
                </div>
            </div>
        </div>
    `;
}

function SectionBrowserModal({ section, onClose, onOpenPhoto }) {
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(() => getSectionBrowserPageSize());

    useEffect(() => {
        setPage(0);
    }, [section?.key]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;

        const syncPageSize = () => {
            setPageSize(getSectionBrowserPageSize());
        };

        window.addEventListener('resize', syncPageSize);

        return () => window.removeEventListener('resize', syncPageSize);
    }, []);

    if (!section) return null;

    const pageCount = Math.max(1, Math.ceil(section.photos.length / pageSize));
    const currentPage = clamp(page, 0, pageCount - 1);
    const pagePhotos = section.photos.slice(
        currentPage * pageSize,
        (currentPage + 1) * pageSize
    );

    const openPhoto = (photoId) => {
        onClose();
        onOpenPhoto(photoId);
    };

    return html`
        <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label=${`${section.title} items`} onClick=${onClose}>
            <div className="gallery-modal gallery-browser-modal" onClick=${(event) => event.stopPropagation()}>
                <div className="gallery-modal-body gallery-browser-body">
                    <div className="gallery-browser-header">
                        <div className="gallery-browser-header-copy">
                            <span className="gallery-kicker">Media set</span>
                            <h2>${section.title}</h2>
                            <p className="gallery-browser-subtitle">
                                ${section.subtitle || `${section.photos.length} items`}
                            </p>
                        </div>
                        <div className="gallery-browser-actions">
                            <span className="gallery-chip gallery-browser-count">${section.photos.length} items</span>
                            <button type="button" className="gallery-button gallery-browser-close" onClick=${onClose}>Close</button>
                        </div>
                    </div>

                    <div className="gallery-grid gallery-grid-browser">
                        ${pagePhotos.map(
                            (photo, index) => html`
                                <${CompactTile}
                                    key=${photo.id}
                                    photo=${photo}
                                    index=${index}
                                    onOpen=${openPhoto} />
                            `
                        )}
                    </div>

                    ${pageCount > 1
                        ? html`
                              <div className="gallery-browser-pagination" role="navigation" aria-label="Gallery pages">
                                  <button
                                      type="button"
                                      className="gallery-button gallery-browser-page-button"
                                      aria-label="Previous page"
                                      onClick=${() => setPage((value) => Math.max(0, value - 1))}
                                      disabled=${currentPage === 0}>
                                      ${html`<${Icon} path="M15 18l-6-6 6-6" size=${16} />`}
                                  </button>
                                  <span className="gallery-chip gallery-browser-page-indicator">
                                      ${currentPage + 1} / ${pageCount}
                                  </span>
                                  <button
                                      type="button"
                                      className="gallery-button gallery-browser-page-button"
                                      aria-label="Next page"
                                      onClick=${() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                                      disabled=${currentPage >= pageCount - 1}>
                                      ${html`<${Icon} path="M9 18l6-6-6-6" size=${16} />`}
                                  </button>
                              </div>
                          `
                        : null}
                </div>
            </div>
        </div>
    `;
}

function ConfirmActionModal({ action, busy, onCancel, onConfirm }) {
    if (!action) return null;

    const photo = action.photo || null;
    const isDelete = action.type === 'delete';
    const mediaLabel = getMediaKindLabel(photo).toLowerCase();

    return html`
        <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label="Confirm action" onClick=${busy ? undefined : onCancel}>
            <div className="gallery-modal gallery-confirm-modal" onClick=${(event) => event.stopPropagation()}>
                <div className="gallery-modal-body gallery-confirm-body">
                    <div className="gallery-confirm-icon ${isDelete ? 'is-danger' : ''}">
                        ${isDelete
                            ? html`<${Icon} path="M3 6h18M8 6V4h8v2m-7 0v12m6-12v12M6 6l1 14h10l1-14" size=${18} />`
                            : html`<${Icon} path="M12 3v11m0 0 4-4m-4 4-4-4M5 18v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" size=${18} />`}
                    </div>
                    <div className="gallery-confirm-copy">
                        <h2>${isDelete ? 'Delete this item?' : 'Download this item?'}</h2>
                        <p>
                            ${isDelete
                                ? `Remove this ${mediaLabel} from the gallery? This action cannot be undone.`
                                : `Download this ${mediaLabel} to your device now?`}
                        </p>
                        ${photo
                            ? html`<span className="gallery-confirm-caption">${getPhotoTitle(photo)}</span>`
                            : null}
                    </div>
                    <div className="gallery-confirm-actions">
                        <button type="button" className="gallery-button" onClick=${onCancel} disabled=${busy}>Cancel</button>
                        <button
                            type="button"
                            className=${cx('gallery-button', isDelete ? 'danger' : 'primary')}
                            onClick=${onConfirm}
                            disabled=${busy}>
                            ${busy
                                ? isDelete ? 'Removing...' : 'Preparing...'
                                : isDelete ? 'Delete' : 'Download'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function CaptionModal({ caption, onClose }) {
    const fullCaption = safeCaption(caption);

    if (!fullCaption) return null;

    return html`
        <div className="gallery-overlay gallery-caption-overlay" role="dialog" aria-modal="true" aria-label="Full caption" onClick=${onClose}>
            <div className="gallery-caption-modal" onClick=${(event) => event.stopPropagation()}>
                <button type="button" className="gallery-icon-button close" onClick=${onClose} aria-label="Close caption">
                    ${html`<${Icon} path="M6 6l12 12M18 6L6 18" />`}
                </button>
                <div className="gallery-caption-modal-body">
                    <span className="gallery-kicker">Full Caption</span>
                    <p className="gallery-caption-full-text">${fullCaption}</p>
                </div>
            </div>
        </div>
    `;
}

function Lightbox({
    photo,
    canDelete,
    canFeature,
    deleting,
    featuring,
    downloading,
    onClose,
    onRequestDelete,
    onRequestDownload,
    onToggleFeatured,
    onNext,
    onPrev
}) {
    const stageRef = useRef(null);
    const imageRef = useRef(null);
    const zoomRef = useRef(1);
    const offsetRef = useRef({ x: 0, y: 0 });
    const dragStateRef = useRef(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const [captionOpen, setCaptionOpen] = useState(false);
    const isVideoCandidate = Boolean(photo && isVideoMedia(photo));
    const lightboxVideoCacheQueuedRef = useRef(false);
    const generatedLightboxPosterUrl = useGeneratedVideoPosterUrl(photo, isVideoCandidate && !photo?.posterUrl);
    const cachedLightboxVideoUrl = useCachedPlaybackUrl(photo?.publicUrl, isVideoCandidate, photo?.publicUrl);

    useEffect(() => {
        lightboxVideoCacheQueuedRef.current = false;
    }, [photo?.publicUrl]);

    if (!photo) return null;
    const isVideo = isVideoMedia(photo);
    const lightboxVideoUrl = cachedLightboxVideoUrl || photo.publicUrl;
    const videoPosterUrl = photo.posterUrl || generatedLightboxPosterUrl || '';
    const title = getPhotoTitle(photo);
    const caption = safeCaption(photo.caption);
    const ownerName = getPhotoOwner(photo);
    const uploadedLabel = formatDisplayDate(getPhotoTimestamp(photo));
    const compactSummary = `${ownerName} / ${formatCompactDate(getPhotoTimestamp(photo))}`;
    const detailCopy = caption && caption.toLowerCase() !== title.toLowerCase() ? caption : '';
    const titlePreview = truncateText(title, LIGHTBOX_CAPTION_PREVIEW_MAX_LENGTH);
    const detailPreview = truncateText(detailCopy, LIGHTBOX_DESCRIPTION_PREVIEW_MAX_LENGTH);
    const fullCaptionText = caption || title;
    const isTitleTruncated = titlePreview !== title;
    const isDetailTruncated = Boolean(detailCopy && detailPreview !== detailCopy);
    const canOpenCaption = Boolean(fullCaptionText && (caption || isTitleTruncated || isDetailTruncated));
    const handleLightboxVideoProgress = (event) => {
        const video = event.currentTarget;
        const duration = Number(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) return;

        if (video.currentTime / duration >= 0.82) {
            queueVideoPlaybackCache(photo, lightboxVideoCacheQueuedRef);
        }
    };

    const commitOffset = (nextOffset) => {
        offsetRef.current = nextOffset;
        setOffset(nextOffset);
    };

    const getClampedOffset = (x, y, nextZoom = zoomRef.current) => {
        const stage = stageRef.current;
        const image = imageRef.current;

        if (!stage || !image || nextZoom <= 1) {
            return { x: 0, y: 0 };
        }

        const baseWidth = image.clientWidth;
        const baseHeight = image.clientHeight;
        if (!baseWidth || !baseHeight) {
            return { x: 0, y: 0 };
        }

        const maxX = Math.max(0, (baseWidth * nextZoom - stage.clientWidth) / 2);
        const maxY = Math.max(0, (baseHeight * nextZoom - stage.clientHeight) / 2);

        return {
            x: clamp(x, -maxX, maxX),
            y: clamp(y, -maxY, maxY)
        };
    };

    const resetView = () => {
        dragStateRef.current = null;
        zoomRef.current = 1;
        offsetRef.current = { x: 0, y: 0 };
        setDragging(false);
        setZoom(1);
        setOffset({ x: 0, y: 0 });
    };

    const setZoomLevel = (nextZoom) => {
        const clampedZoom = clamp(Math.round(nextZoom * 100) / 100, 1, 5);
        zoomRef.current = clampedZoom;
        setZoom(clampedZoom);
        commitOffset(clampedZoom <= 1 ? { x: 0, y: 0 } : getClampedOffset(offsetRef.current.x, offsetRef.current.y, clampedZoom));
    };

    useEffect(() => {
        resetView();
        setCaptionOpen(false);
    }, [photo.id]);

    useEffect(() => {
        const handleResize = () => {
            if (isVideo) return;
            if (zoomRef.current <= 1) return;
            commitOffset(getClampedOffset(offsetRef.current.x, offsetRef.current.y, zoomRef.current));
        };

        const handleKeyDown = (event) => {
            if (isVideo) return;
            if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                setZoomLevel(zoomRef.current + 0.25);
            }

            if (event.key === '-') {
                event.preventDefault();
                setZoomLevel(zoomRef.current - 0.25);
            }

            if (event.key === '0') {
                event.preventDefault();
                resetView();
            }
        };

        window.addEventListener('resize', handleResize);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('resize', handleResize);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [photo.id, isVideo]);

    const handlePointerDown = (event) => {
        if (isVideo) return;
        if (zoomRef.current <= 1) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        dragStateRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: offsetRef.current.x,
            originY: offsetRef.current.y
        };
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };

    const handlePointerMove = (event) => {
        if (isVideo) return;
        const dragState = dragStateRef.current;
        if (!dragState) return;

        event.preventDefault();
        commitOffset(
            getClampedOffset(
                dragState.originX + (event.clientX - dragState.startX),
                dragState.originY + (event.clientY - dragState.startY),
                zoomRef.current
            )
        );
    };

    const handlePointerUp = (event) => {
        if (isVideo) return;
        if (!dragStateRef.current) return;

        dragStateRef.current = null;
        setDragging(false);

        try {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        } catch (_error) {
            null;
        }
    };

    const handleWheel = (event) => {
        if (isVideo) return;
        event.preventDefault();
        setZoomLevel(zoomRef.current + (event.deltaY < 0 ? 0.2 : -0.2));
    };

    const handleDoubleClick = () => {
        if (isVideo) return;
        if (zoomRef.current > 1.2) {
            resetView();
            return;
        }

        setZoomLevel(2);
    };

    return html`
        <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label="Media viewer" onClick=${onClose}>
            <div className="gallery-lightbox" onClick=${(event) => event.stopPropagation()}>
                <button type="button" className="gallery-icon-button close" onClick=${onClose} aria-label="Close viewer">
                    ${html`<${Icon} path="M6 6l12 12M18 6L6 18" />`}
                </button>
                <div className="gallery-lightbox-stage">
                    <button type="button" className="gallery-icon-button nav-prev" onClick=${onPrev} aria-label="Previous item">
                        ${html`<${Icon} path="M15 18l-6-6 6-6" />`}
                    </button>
                    <button type="button" className="gallery-icon-button nav-next" onClick=${onNext} aria-label="Next item">
                        ${html`<${Icon} path="M9 18l6-6-6-6" />`}
                    </button>
                    <div
                        ref=${stageRef}
                        className=${cx('gallery-lightbox-viewport', isVideo && 'is-video', !isVideo && zoom > 1 && 'is-zoomed', !isVideo && dragging && 'is-dragging')}
                        onWheel=${isVideo ? undefined : handleWheel}
                        onDoubleClick=${isVideo ? undefined : handleDoubleClick}
                        onPointerDown=${isVideo ? undefined : handlePointerDown}
                        onPointerMove=${isVideo ? undefined : handlePointerMove}
                        onPointerUp=${isVideo ? undefined : handlePointerUp}
                        onPointerCancel=${isVideo ? undefined : handlePointerUp}>
                        ${isVideo
                            ? html`
                                  <video
                                      key=${photo.publicUrl}
                                      className="gallery-lightbox-media is-video"
                                      src=${lightboxVideoUrl}
                                      controls
                                      controlsList="nodownload noremoteplayback"
                                      disablePictureInPicture=${true}
                                      playsInline
                                      poster=${videoPosterUrl || undefined}
                                      style=${getPhotoSurfaceStyle(photo)}
                                      preload="none"
                                      onTimeUpdate=${handleLightboxVideoProgress}
                                      onEnded=${() => queueVideoPlaybackCache(photo, lightboxVideoCacheQueuedRef)}></video>
                              `
                            : html`
                                  <img
                                      ref=${imageRef}
                                      className="gallery-lightbox-media is-image"
                                      src=${photo.publicUrl}
                                      alt=${getPhotoTitle(photo)}
                                      onLoad=${() => commitOffset(getClampedOffset(offsetRef.current.x, offsetRef.current.y, zoomRef.current))}
                                      style=${{
                                          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`
                                      }} />
                              `}
                    </div>
                </div>
                <aside className="gallery-lightbox-sidebar">
                    <div className="gallery-lightbox-heading">
                        <span className="gallery-kicker">Lynmark Memory</span>
                        <h2>
                            ${canOpenCaption
                                ? html`
                                      <button
                                          type="button"
                                          className=${cx('gallery-lightbox-caption-trigger', isTitleTruncated && 'is-truncated')}
                                          onClick=${() => setCaptionOpen(true)}
                                          title=${fullCaptionText}
                                          aria-label="View full caption">
                                          ${titlePreview}
                                      </button>
                                  `
                                : titlePreview}
                        </h2>
                        <p className="gallery-lightbox-summary">${compactSummary}</p>
                        ${detailCopy
                            ? html`
                                  <button
                                      type="button"
                                      className=${cx('gallery-lightbox-description', 'gallery-lightbox-description-button', isDetailTruncated && 'is-truncated')}
                                      onClick=${() => setCaptionOpen(true)}
                                      title=${detailCopy}
                                      aria-label="View full caption">
                                      ${detailPreview}
                                  </button>
                              `
                            : null}
                    </div>
                    <div className="gallery-lightbox-toolbar-row">
                        <div className="gallery-lightbox-uploaded">
                            <span>Uploaded</span>
                            <strong>${uploadedLabel}</strong>
                        </div>
                        <div className="gallery-lightbox-tools" role="toolbar" aria-label="Media actions">
                            <button
                                type="button"
                                className="gallery-lightbox-tool"
                                aria-label="Download item"
                                title="Download"
                                onClick=${onRequestDownload}
                                disabled=${downloading}>
                                ${html`<${Icon} path="M12 3v11m0 0 4-4m-4 4-4-4M5 18v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" size=${16} />`}
                            </button>
                            ${canFeature
                                ? html`
                                      <button
                                          type="button"
                                          className=${cx('gallery-lightbox-tool', photo.is_featured && 'is-active')}
                                          aria-label=${photo.is_featured ? 'Unpin from slideshow' : 'Pin to slideshow'}
                                          title=${photo.is_featured ? 'Pinned to slideshow' : 'Pin to slideshow'}
                                          onClick=${onToggleFeatured}
                                          disabled=${featuring}>
                                          ${html`<${Icon} path="M12 3l2.8 5.67 6.26.91-4.53 4.42 1.07 6.24L12 17.27 6.4 20.24l1.07-6.24L2.94 9.58l6.26-.91L12 3Z" size=${16} />`}
                                      </button>
                                  `
                                : null}
                            ${canDelete
                                ? html`
                                      <button
                                          type="button"
                                          className="gallery-lightbox-tool is-danger"
                                          aria-label="Delete item"
                                          title="Delete"
                                          onClick=${onRequestDelete}
                                          disabled=${deleting}>
                                          ${html`<${Icon} path="M3 6h18M8 6V4h8v2m-7 0v12m6-12v12M6 6l1 14h10l1-14" size=${16} />`}
                                      </button>
                                  `
                                : null}
                        </div>
                    </div>
                    <div className="gallery-lightbox-meta">
                        <div className="gallery-lightbox-meta-row">
                            <span>Uploaded by</span>
                            <span>${ownerName}</span>
                        </div>
                        <div className="gallery-lightbox-meta-row">
                            <span>Resolution</span>
                            <span>${photo.width && photo.height ? `${photo.width} x ${photo.height}` : 'Unknown'}</span>
                        </div>
                    </div>
                    <p className="gallery-lightbox-hint">
                        ${isVideo
                            ? 'Use the player controls to play, pause, or scrub through the video.'
                            : zoom > 1
                              ? 'Drag to pan. Double-click or reset to center.'
                              : 'Zoom in to inspect details.'}
                    </p>
                    <div className="gallery-lightbox-actions">
                        ${!isVideo
                            ? html`
                                  <div className="gallery-lightbox-zoom" role="group" aria-label="Image zoom controls">
                                      <button
                                          type="button"
                                          className="gallery-button"
                                          onClick=${() => setZoomLevel(zoomRef.current - 0.25)}
                                          disabled=${zoom <= 1}
                                          aria-label="Zoom out">
                                          ${html`<${Icon} path="M5 12h14" size=${18} />`}
                                      </button>
                                      <button
                                          type="button"
                                          className="gallery-button gallery-lightbox-zoom-readout"
                                          onClick=${resetView}
                                          aria-label="Reset zoom">
                                          ${Math.round(zoom * 100)}%
                                      </button>
                                      <button
                                          type="button"
                                          className="gallery-button"
                                          onClick=${() => setZoomLevel(zoomRef.current + 0.25)}
                                          disabled=${zoom >= 5}
                                          aria-label="Zoom in">
                                          ${html`<${Icon} path="M12 5v14M5 12h14" size=${18} />`}
                                      </button>
                                  </div>
                              `
                            : null}
                    </div>
                </aside>
                ${captionOpen
                    ? html`
                          <${CaptionModal}
                              caption=${fullCaptionText}
                              onClose=${() => setCaptionOpen(false)} />
                      `
                    : null}
            </div>
        </div>
    `;
}

function UploadModal({
    currentUser,
    draft,
    busy,
    errorMessage,
    progress,
    onClose,
    onFilesSelected,
    onRemoveFile,
    onFieldChange,
    onUpload
}) {
    const fileInputRef = useRef(null);
    const [dragging, setDragging] = useState(false);
    const activeProgressItem = progress?.items?.[progress.activeIndex] || null;

    if (!currentUser) return null;

    const pickFiles = () => {
        const input = fileInputRef.current;
        if (!input) return;
        input.value = '';
        input.click();
    };

    const handleInputChange = (event) => {
        const input = event.currentTarget;
        const files = Array.from(input.files || []);
        input.value = '';

        if (!files.length) return;
        onFilesSelected(files);
    };

    const handleDrop = (event) => {
        event.preventDefault();
        setDragging(false);
        const files = Array.from(event.dataTransfer?.files || []);
        onFilesSelected(files);
    };

    return html`
        <div className="gallery-overlay" role="dialog" aria-modal="true" aria-label="Upload media" onClick=${onClose}>
            <div className="gallery-modal" onClick=${(event) => event.stopPropagation()}>
                <div className="gallery-modal-body">
                    <div className="gallery-modal-header">
                        <div>
                            <span className="gallery-kicker">Upload</span>
                            <h2>Upload media</h2>
                        </div>
                        <button type="button" className="gallery-button" onClick=${onClose} disabled=${busy}>Close</button>
                    </div>

                    <div
                        className=${cx('gallery-upload-zone', dragging && 'is-dragging')}
                        onDragOver=${(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave=${() => setDragging(false)}
                        onDrop=${handleDrop}>
                        <input
                            ref=${fileInputRef}
                            className="gallery-hidden-input"
                            type="file"
                            accept="image/*,video/mp4,video/webm,video/ogg,video/quicktime,video/x-m4v"
                            multiple
                            onChange=${handleInputChange} />
                        <strong>Drop media here</strong>
                        <span className="gallery-muted">Images and videos up to ${MAX_UPLOAD_MB}MB each.</span>
                        <div className="gallery-upload-actions" style=${{ justifyContent: 'center' }}>
                            <button type="button" className="gallery-button primary" onClick=${pickFiles} disabled=${busy}>Select files</button>
                        </div>
                    </div>

                    <div className="gallery-field">
                        <label htmlFor="gallery-caption">Caption</label>
                        <textarea
                            id="gallery-caption"
                            value=${draft.caption}
                            onChange=${(event) => onFieldChange('caption', event.target.value)}
                            placeholder="Optional caption"></textarea>
                    </div>

                    ${errorMessage ? html`<div className="gallery-status error">${errorMessage}</div>` : null}

                    ${progress && progress.totalBytes
                        ? html`
                              <div className="gallery-upload-progress" role="status" aria-live="polite">
                                  <div className="gallery-upload-progress-head">
                                      <strong>${progress.stageLabel || 'Preparing upload...'}</strong>
                                      <span className="gallery-upload-progress-percent">${percentageLabel(progress.percentage)}</span>
                                  </div>
                                  <div
                                      className="gallery-upload-progress-bar"
                                      role="progressbar"
                                      aria-valuemin="0"
                                      aria-valuemax="100"
                                      aria-valuenow=${Math.round(progress.percentage)}>
                                      <span style=${{ width: `${progress.percentage}%` }}></span>
                                  </div>
                                  <div className="gallery-upload-progress-meta">
                                      <span>${fileSizeLabel(progress.uploadedBytes)} of ${fileSizeLabel(progress.totalBytes)} uploaded</span>
                                      <span>${uploadSpeedLabel(progress.speedBytesPerSecond)}</span>
                                      ${activeProgressItem
                                          ? html`<span>File ${progress.activeIndex + 1} of ${progress.items.length}</span>`
                                          : null}
                                  </div>
                              </div>
                          `
                        : null}

                    <div className="gallery-caption-list">
                        <strong>${draft.files.length ? `${draft.files.length} selected` : 'No files selected'}</strong>
                        <div className="gallery-file-list">
                            ${draft.files.map(
                                (file, index) => {
                                    const progressItem = progress?.items?.[index] || null;

                                    return html`
                                    <div className=${cx('gallery-file-item', progressItem?.status === 'uploading' && 'is-uploading')} key=${`${file.name}-${index}`}>
                                        <div className="gallery-file-meta">
                                            <span className="gallery-file-name">${file.name}</span>
                                            <div className="gallery-file-detail-row">
                                                <span className="gallery-file-size">${fileSizeLabel(file.size)}</span>
                                                ${progressItem
                                                    ? html`
                                                          <span className=${cx('gallery-file-status', `is-${progressItem.status}`)}>
                                                              ${getUploadItemStatusLabel(progressItem)}
                                                          </span>
                                                      `
                                                    : null}
                                            </div>
                                            ${progressItem
                                                ? html`
                                                      <div className="gallery-file-progress" aria-hidden="true">
                                                          <span style=${{ width: `${progressItem.percentage}%` }}></span>
                                                      </div>
                                                  `
                                                : null}
                                        </div>
                                        <button type="button" className="gallery-button" onClick=${() => onRemoveFile(index)} disabled=${busy}>
                                            Remove
                                        </button>
                                    </div>
                                `;
                                }
                            )}
                        </div>
                    </div>

                    <div className="gallery-upload-actions">
                        <button type="button" className="gallery-button" onClick=${onClose} disabled=${busy}>Cancel</button>
                        <button type="button" className="gallery-button primary" onClick=${onUpload} disabled=${busy || !draft.files.length}>
                            ${busy ? 'Uploading...' : 'Upload files'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function App() {
    const [initialGalleryCache] = useState(() => readGalleryPhotoCache());
    const [metadataPageSize] = useState(() => getGalleryMetadataPageSize());
    const loadingMorePhotosRef = useRef(false);
    const [client, setClient] = useState(null);
    const [currentUser, setCurrentUser] = useState(() => getStoredUser());
    const [photos, setPhotos] = useState(() => initialGalleryCache.photos);
    const [loading, setLoading] = useState(() => !initialGalleryCache.photos.length);
    const [loadingMorePhotos, setLoadingMorePhotos] = useState(false);
    const [remoteLoadedCount, setRemoteLoadedCount] = useState(() => (
        initialGalleryCache.isFresh ? initialGalleryCache.photos.length : 0
    ));
    const [hasMorePhotos, setHasMorePhotos] = useState(() => (
        !initialGalleryCache.isFresh || initialGalleryCache.photos.length >= getGalleryMetadataPageSize()
    ));
    const [initialLoadComplete, setInitialLoadComplete] = useState(() => Boolean(initialGalleryCache.photos.length));
    const [errorMessage, setErrorMessage] = useState('');
    const [uploadErrorMessage, setUploadErrorMessage] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [viewMode, setViewMode] = useState('days');
    const [visibleSectionLimit, setVisibleSectionLimit] = useState(() => getInitialVisibleSectionCount());
    const [slideshowOrderMode, setSlideshowOrderMode] = useState('latest');
    const [slideshowMediaFilter, setSlideshowMediaFilter] = useState('all');
    const [slideshowShuffleSeed, setSlideshowShuffleSeed] = useState(() => Date.now());
    const [themeMode, setThemeMode] = useState(() => getStoredThemeMode());
    const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());
    const [search, setSearch] = useState('');
    const [activePhotoId, setActivePhotoId] = useState(null);
    const [sectionBrowser, setSectionBrowser] = useState(null);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadBusy, setUploadBusy] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [downloadBusy, setDownloadBusy] = useState(false);
    const [featureBusy, setFeatureBusy] = useState(false);
    const [confirmAction, setConfirmAction] = useState(null);
    const [uploadDraft, setUploadDraft] = useState({
        files: [],
        caption: ''
    });

    const deferredSearch = useDeferredValue(search);
    const isScrollCooling = useScrollCooling(isConstrainedGalleryDevice());

    useEffect(() => {
        try {
            setClient(createSupabaseClient());
        } catch (error) {
            setErrorMessage(error.message || 'Gallery is unavailable right now.');
            setLoading(false);
            setInitialLoadComplete(true);
        }

        const syncUser = () => {
            if (document.visibilityState === 'hidden') {
                return;
            }

            const nextUser = getStoredUser();
            setCurrentUser((previousUser) => (
                areUsersEquivalent(previousUser, nextUser) ? previousUser : nextUser
            ));
        };

        window.addEventListener('storage', syncUser);
        window.addEventListener('focus', syncUser);
        document.addEventListener('visibilitychange', syncUser);

        return () => {
            window.removeEventListener('storage', syncUser);
            window.removeEventListener('focus', syncUser);
            document.removeEventListener('visibilitychange', syncUser);
        };
    }, []);

    async function refreshPhotos({ silent = false, preserveExisting = true } = {}) {
        if (!client) return;

        if (!silent) {
            setLoading(true);
        }
        setErrorMessage('');

        try {
            const rows = await listGalleryPhotos(client, {
                limit: metadataPageSize + 1,
                offset: 0
            });
            const pageRows = rows.slice(0, metadataPageSize);
            const nextPagePhotos = pageRows.map((photo) => enrichPhoto(client, photo));
            setHasMorePhotos(rows.length > metadataPageSize);
            setRemoteLoadedCount(pageRows.length);

            const commitPhotos = () => setPhotos((previousPhotos) => {
                const basePhotos = preserveExisting ? previousPhotos : [];
                const nextPhotos = mergePhotoLists(nextPagePhotos, basePhotos);
                writeGalleryPhotoCache(nextPhotos);
                return nextPhotos;
            });

            if (initialLoadComplete) {
                startTransition(commitPhotos);
            } else {
                commitPhotos();
            }
        } catch (error) {
            console.error('Gallery load failed:', error);
            setErrorMessage(photos.length
                ? 'Showing saved gallery. New uploads may appear after the next refresh.'
                : error.message || 'Unable to open the gallery right now.');
        } finally {
            setLoading(false);
            setInitialLoadComplete(true);
        }
    }

    async function loadMorePhotos() {
        if (!client || loadingMorePhotos || loadingMorePhotosRef.current || !hasMorePhotos) return;

        loadingMorePhotosRef.current = true;
        setLoadingMorePhotos(true);
        setErrorMessage('');

        try {
            const offset = remoteLoadedCount;
            const rows = await listGalleryPhotos(client, {
                limit: metadataPageSize + 1,
                offset
            });
            const pageRows = rows.slice(0, metadataPageSize);
            const nextPagePhotos = pageRows.map((photo) => enrichPhoto(client, photo));

            setRemoteLoadedCount(offset + pageRows.length);
            setHasMorePhotos(rows.length > metadataPageSize);
            setPhotos((previousPhotos) => {
                const nextPhotos = mergePhotoLists(previousPhotos, nextPagePhotos);
                writeGalleryPhotoCache(nextPhotos);
                return nextPhotos;
            });
        } catch (error) {
            console.error('Gallery page load failed:', error);
            setErrorMessage('Could not load more gallery items right now.');
        } finally {
            loadingMorePhotosRef.current = false;
            setLoadingMorePhotos(false);
            setInitialLoadComplete(true);
        }
    }

    useEffect(() => {
        if (!client) return;
        if (initialGalleryCache.photos.length && initialGalleryCache.isFresh) {
            setLoading(false);
            setRemoteLoadedCount(initialGalleryCache.photos.length);
            setHasMorePhotos(initialGalleryCache.photos.length >= metadataPageSize);
            setInitialLoadComplete(true);
            return;
        }

        refreshPhotos({ silent: initialGalleryCache.photos.length > 0 });
    }, [client, metadataPageSize]);

    useEffect(() => {
        if (!activePhotoId) return;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') setActivePhotoId(null);
            if (event.key === 'ArrowRight') moveSelection(1);
            if (event.key === 'ArrowLeft') moveSelection(-1);
        };

        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    });

    useEffect(() => {
        if (!sectionBrowser) return;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                setSectionBrowser(null);
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [sectionBrowser]);

    useEffect(() => {
        const syncThemeFromLocalTime = () => setSystemTheme(getSystemTheme());

        syncThemeFromLocalTime();
        const intervalId = window.setInterval(syncThemeFromLocalTime, 60000);

        return () => window.clearInterval(intervalId);
    }, []);

    useEffect(() => {
        applyGalleryTheme(themeMode, systemTheme);

        try {
            localStorage.setItem(GALLERY_THEME_STORAGE_KEY, themeMode);
        } catch (_error) {
            // Ignore storage failures so the gallery still works in restricted browsers.
        }
    }, [themeMode, systemTheme]);

    const query = deferredSearch.trim().toLowerCase();
    const filteredPhotos = query ? photos.filter((photo) => photo.searchText.includes(query)) : photos;
    const filteredSignature = filteredPhotos.map((photo) => photo.id).join('|');
    const daySections = buildDaySections(filteredPhotos);
    const monthSections = buildMonthSections(filteredPhotos);
    const visibleDaySections = daySections.slice(0, visibleSectionLimit);
    const visibleMonthSections = monthSections.slice(0, visibleSectionLimit);
    const slideshowPhotos = getSlideshowPhotos(
        filteredPhotos,
        slideshowMediaFilter,
        slideshowOrderMode,
        slideshowShuffleSeed,
        DEFAULT_SLIDESHOW_LIMIT
    );
    const activeIndex = filteredPhotos.findIndex((photo) => photo.id === activePhotoId);
    const activePhoto = activeIndex >= 0 ? filteredPhotos[activeIndex] : null;
    const resolvedTheme = resolveGalleryTheme(themeMode, systemTheme);

    useEffect(() => {
        setVisibleSectionLimit(getInitialVisibleSectionCount());
    }, [viewMode, query]);

    const canRevealMoreDaySections = viewMode === 'days' && visibleDaySections.length < daySections.length;
    const canRevealMoreMonthSections = viewMode === 'months' && visibleMonthSections.length < monthSections.length;
    const canRevealMoreLocalSections = canRevealMoreDaySections || canRevealMoreMonthSections;
    const canLoadMoreGalleryItems = hasMorePhotos && !loadingMorePhotos;
    const hasMoreGalleryContent = canRevealMoreLocalSections || hasMorePhotos;
    const loadMoreLabel = canRevealMoreDaySections
        ? 'Show more days'
        : canRevealMoreMonthSections
            ? 'Show more months'
            : 'Load more memories';
    const handleNeedMoreGalleryContent = () => {
        if (canRevealMoreLocalSections) {
            setVisibleSectionLimit((current) => current + getSectionBatchSize());
            return;
        }

        if (canLoadMoreGalleryItems) {
            loadMorePhotos();
        }
    };

    const canUpload = Boolean(currentUser?.id);
    const canDelete = Boolean(
        activePhoto &&
        currentUser?.id &&
        (currentUser.id === activePhoto.owner_user_id || String(currentUser.role || '').toLowerCase() === 'admin')
    );
    const canFeature = canDelete;

    useEffect(() => {
        if (!activePhoto) {
            setConfirmAction(null);
        }
    }, [activePhoto?.id]);

    function moveSelection(direction) {
        if (!filteredPhotos.length) return;
        const currentIndex = Math.max(activeIndex, 0);
        const nextIndex = (currentIndex + direction + filteredPhotos.length) % filteredPhotos.length;
        setActivePhotoId(filteredPhotos[nextIndex].id);
    }

    useEffect(() => {
        if (slideshowOrderMode !== 'shuffle') return;
        setSlideshowShuffleSeed((current) => current + 1);
    }, [slideshowOrderMode, slideshowMediaFilter, filteredSignature]);

    function updateDraftField(field, value) {
        setUploadDraft((previous) => ({
            ...previous,
            [field]: value
        }));
    }

    function resetUploadFeedback() {
        setUploadErrorMessage('');
        setUploadProgress(null);
    }

    function patchUploadProgress(fileIndex, filePatch, meta = {}) {
        startTransition(() => {
            setUploadProgress((previous) => updateUploadProgressState(previous, fileIndex, filePatch, meta));
        });
    }

    function resetUploadDraft() {
        setUploadDraft({
            files: [],
            caption: ''
        });
    }

    function handleFilesSelected(files) {
        const nextFiles = files.filter((file) => isSupportedMediaFile(file));
        setUploadErrorMessage('');
        if (!uploadBusy) {
            setUploadProgress(null);
        }
        setUploadDraft((previous) => ({
            ...previous,
            files: [...previous.files, ...nextFiles]
        }));
    }

    function removeDraftFile(index) {
        setUploadErrorMessage('');
        if (!uploadBusy) {
            setUploadProgress(null);
        }
        setUploadDraft((previous) => ({
            ...previous,
            files: previous.files.filter((_, fileIndex) => fileIndex !== index)
        }));
    }

    async function handleUpload() {
        if (!client) return;
        if (!canUpload) {
            setUploadErrorMessage('Sign in from the Billing Tracker first so uploads can be linked to your account.');
            return;
        }
        if (!uploadDraft.files.length) {
            setUploadErrorMessage('Choose at least one file to upload.');
            return;
        }

        const filesToUpload = [...uploadDraft.files];
        let activeUploadIndex = -1;
        let activeUploadFile = null;

        setUploadBusy(true);
        setUploadErrorMessage('');
        setErrorMessage('');
        setStatusMessage('');
        setUploadProgress(createUploadProgressState(filesToUpload));

        try {
            for (let index = 0; index < filesToUpload.length; index += 1) {
                const file = filesToUpload[index];

                if (file.size > MAX_UPLOAD_BYTES) {
                    throw new Error(`${file.name} is larger than ${MAX_UPLOAD_MB}MB.`);
                }

                activeUploadIndex = index;
                activeUploadFile = file;

                const storagePath = buildStoragePath(currentUser, file);
                const detailsPromise = readMediaDetailsSafe(file);
                let posterPromise = Promise.resolve(null);
                const uploadedAt = new Date().toISOString();
                let lastProgressAt = performance.now();
                let lastProgressBytes = 0;
                let smoothedSpeed = 0;

                patchUploadProgress(index, {
                    status: 'preparing',
                    errorMessage: '',
                    speedBytesPerSecond: 0
                }, {
                    activeIndex: index,
                    activeFileName: file.name,
                    speedBytesPerSecond: 0,
                    stageLabel: `Preparing ${file.name} (${index + 1} of ${filesToUpload.length})...`
                });

                await uploadFileResumable(client, storagePath, file, {
                    onProgress(bytesUploaded, bytesTotal) {
                        const now = performance.now();
                        const elapsedSeconds = Math.max((now - lastProgressAt) / 1000, 0.001);
                        const deltaBytes = Math.max(bytesUploaded - lastProgressBytes, 0);

                        if (deltaBytes > 0) {
                            const measuredSpeed = deltaBytes / elapsedSeconds;
                            smoothedSpeed = smoothedSpeed ? (smoothedSpeed * 0.62) + (measuredSpeed * 0.38) : measuredSpeed;
                            lastProgressAt = now;
                            lastProgressBytes = bytesUploaded;
                        }

                        patchUploadProgress(index, {
                            status: 'uploading',
                            uploadedBytes: bytesUploaded,
                            totalBytes: bytesTotal,
                            speedBytesPerSecond: smoothedSpeed,
                            errorMessage: ''
                        }, {
                            activeIndex: index,
                            activeFileName: file.name,
                            speedBytesPerSecond: smoothedSpeed,
                            stageLabel: `Uploading ${file.name} (${index + 1} of ${filesToUpload.length})...`
                        });
                    }
                });

                posterPromise = isVideoMedia(file)
                    ? uploadVideoPoster(client, storagePath, file)
                    : Promise.resolve(null);

                const [details, posterStoragePath] = await Promise.all([detailsPromise, posterPromise]);

                patchUploadProgress(index, {
                    status: 'finalizing',
                    uploadedBytes: file.size,
                    totalBytes: file.size,
                    speedBytesPerSecond: 0,
                    errorMessage: ''
                }, {
                    activeIndex: index,
                    activeFileName: file.name,
                    speedBytesPerSecond: 0,
                    stageLabel: `Saving ${file.name} to the gallery...`
                });

                await createGalleryPhoto(client, {
                    p_actor_user_id: currentUser.id,
                    p_bucket_name: GALLERY_BUCKET,
                    p_storage_path: storagePath,
                    p_caption: safeCaption(uploadDraft.caption) || safeCaption(file.name.replace(/\.[^/.]+$/, '')),
                    p_taken_at: uploadedAt,
                    p_width: details.width,
                    p_height: details.height,
                    p_dominant_color: details.dominantColor,
                    p_poster_storage_path: posterStoragePath,
                    p_video_variants: isVideoMedia(file) && details.durationSeconds
                        ? { duration_seconds: details.durationSeconds }
                        : {}
                });

                patchUploadProgress(index, {
                    status: 'complete',
                    uploadedBytes: file.size,
                    totalBytes: file.size,
                    speedBytesPerSecond: 0,
                    errorMessage: ''
                }, {
                    activeIndex: index,
                    activeFileName: file.name,
                    speedBytesPerSecond: 0,
                    stageLabel: index === filesToUpload.length - 1
                        ? 'Finalizing gallery...'
                        : `Uploaded ${file.name}. Preparing the next file...`
                });
            }

            setStatusMessage(
                `${filesToUpload.length} item${filesToUpload.length === 1 ? '' : 's'} added to the gallery.`
            );
            resetUploadDraft();
            resetUploadFeedback();
            setUploadOpen(false);
            await refreshPhotos();
        } catch (error) {
            console.error('Upload failed:', error);
            const message = error?.message || 'The upload did not finish. Please try again.';

            if (activeUploadIndex >= 0) {
                patchUploadProgress(activeUploadIndex, {
                    status: 'error',
                    speedBytesPerSecond: 0,
                    errorMessage: message
                }, {
                    activeIndex: activeUploadIndex,
                    activeFileName: activeUploadFile?.name || '',
                    speedBytesPerSecond: 0,
                    stageLabel: 'Upload stopped.'
                });
            }

            setUploadErrorMessage(message);
        } finally {
            setUploadBusy(false);
        }
    }

    async function handleDeleteActivePhoto() {
        if (!client || !activePhoto || !currentUser?.id) return;
        setDeleteBusy(true);
        setErrorMessage('');

        try {
            await deleteGalleryPhoto(client, currentUser.id, activePhoto);
            setActivePhotoId(null);
            setPhotos((previousPhotos) => {
                const nextPhotos = previousPhotos.filter((photo) => photo.id !== activePhoto.id);
                writeGalleryPhotoCache(nextPhotos);
                return nextPhotos;
            });
            setStatusMessage('Item removed.');
            await refreshPhotos();
        } catch (error) {
            console.error('Delete failed:', error);
            setErrorMessage(error.message || 'Unable to delete the selected item.');
        } finally {
            setDeleteBusy(false);
        }
    }

    async function handleDownloadActivePhoto() {
        if (!client || !activePhoto) return;

        setDownloadBusy(true);
        setErrorMessage('');

        try {
            await downloadGalleryPhoto(client, activePhoto);
            setStatusMessage('Download started.');
        } catch (error) {
            console.error('Download failed:', error);
            setErrorMessage(error.message || 'Unable to download the selected item.');
        } finally {
            setDownloadBusy(false);
        }
    }

    async function handleToggleFeaturedActivePhoto() {
        if (!client || !activePhoto || !currentUser?.id) return;

        const nextFeatured = !activePhoto.is_featured;
        setFeatureBusy(true);
        setErrorMessage('');

        try {
            await setGalleryPhotoFeatured(client, currentUser.id, activePhoto.id, nextFeatured);
            setPhotos((previous) => {
                const nextPhotos = previous.map((photo) => (
                    photo.id === activePhoto.id
                        ? { ...photo, is_featured: nextFeatured }
                        : photo
                ));
                writeGalleryPhotoCache(nextPhotos);
                return nextPhotos;
            });
            setStatusMessage(nextFeatured ? 'Pinned to slideshow.' : 'Removed from pinned slideshow.');
        } catch (error) {
            console.error('Pin update failed:', error);
            setErrorMessage(error.message || 'Unable to update slideshow pin.');
        } finally {
            setFeatureBusy(false);
        }
    }

    const openSectionBrowser = (section) => setSectionBrowser(section);
    const showBootLoader = !initialLoadComplete && loading;

    const openUploadPanel = () => {
        setUploadOpen(true);
    };

    const closeConfirmAction = () => {
        if (deleteBusy || downloadBusy) return;
        setConfirmAction(null);
    };

    const requestDeleteActivePhoto = () => {
        if (!activePhoto) return;
        setConfirmAction({ type: 'delete', photo: activePhoto });
    };

    const requestDownloadActivePhoto = () => {
        if (!activePhoto) return;
        setConfirmAction({ type: 'download', photo: activePhoto });
    };

    async function handleSignOut() {
        const sessionToken = getStoredSessionToken();

        try {
            if (client && sessionToken) {
                await client.rpc('custom_logout', {
                    p_session_token: sessionToken
                });
            }
        } catch (error) {
            console.warn('Gallery sign out session revoke failed:', error?.message || error);
        }

        try {
            localStorage.removeItem('billing_user');
            localStorage.removeItem('billing_session');
        } catch (_error) {
            null;
        }

        setCurrentUser(null);
        setUploadOpen(false);
        setUploadErrorMessage('');
        setStatusMessage('Signed out.');
    }

    async function handleConfirmAction() {
        if (!confirmAction) return;

        if (confirmAction.type === 'delete') {
            await handleDeleteActivePhoto();
        } else if (confirmAction.type === 'download') {
            await handleDownloadActivePhoto();
        }

        setConfirmAction(null);
    }

    const renderHeaderActions = () => html`
        <div className="gallery-action-rail" role="toolbar" aria-label="Gallery actions">
            <a href="index.html" className="gallery-button">
                ${html`<${Icon} path="M15 18l-6-6 6-6" size=${18} />`}
                <span className="gallery-action-label">Home</span>
            </a>
            ${canUpload
                ? html`
                      <button type="button" className="gallery-button primary" onClick=${openUploadPanel}>
                          ${html`<${Icon} path="M12 5v14M5 12h14" size=${18} />`}
                          <span className="gallery-action-label">Upload</span>
                      </button>
                  `
                : html`
                      <a href="billing.html" className="gallery-button primary">
                          ${html`<${Icon} path="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" size=${18} />`}
                          <span className="gallery-action-label">Sign in</span>
                      </a>
                  `}
        </div>
    `;

    if (showBootLoader) {
        return html`<${GalleryLoader} label="Opening gallery" />`;
    }

    return html`
        <div className="gallery-shell">
            <nav className="gallery-nav">
                <div className="gallery-brand">
                    <div className="gallery-brand-badge" aria-hidden="true">
                        <img src="lynmark-logo.png" alt="Lynmark Logo" className="gallery-brand-mark" />
                    </div>
                    <div className="gallery-brand-copy">
                        <span className="gallery-kicker">Lynmark System</span>
                        <div className="gallery-title-row">
                            <h1 className="gallery-title">Gallery</h1>
                            ${renderHeaderActions()}
                        </div>
                        <p className="gallery-subtitle">
                            Shared moments.
                        </p>
                    </div>
                </div>
                ${currentUser
                    ? html`
                          <div className="gallery-header-tools">
                              <div className="gallery-profile-badge" aria-label=${`Signed in as ${getUserDisplayName(currentUser)}`}>
                                  <span className="gallery-profile-avatar" aria-hidden="true">${getUserInitials(currentUser)}</span>
                                  <span className="gallery-profile-copy">
                                      <span className="gallery-profile-label">Signed in as</span>
                                      <strong>${getUserDisplayName(currentUser)}</strong>
                                      <span>${getUserProfileDetail(currentUser)}</span>
                                  </span>
                                  <button type="button" className="gallery-profile-signout" onClick=${handleSignOut}>
                                      Sign out
                                  </button>
                              </div>
                          </div>
                      `
                    : null}
            </nav>

            <main className="gallery-main">
                <section className="gallery-hero">
                    <article className="gallery-card gallery-mosaic">
                        ${slideshowPhotos.length
                            ? html`
                                  <${HeroSlideshow}
                                      photos=${slideshowPhotos}
                                      orderMode=${slideshowOrderMode}
                                      mediaFilter=${slideshowMediaFilter}
                                      pausePlayback=${Boolean(activePhoto) || isScrollCooling}
                                      onOpen=${(photoId) => setActivePhotoId(photoId)} />
                              `
                            : html`
                                      <${SlideshowEmptyState}
                                          mediaFilter=${slideshowMediaFilter}
                                          orderMode=${slideshowOrderMode}
                                          onReset=${() => {
                                          setSlideshowOrderMode('latest');
                                          setSlideshowMediaFilter('all');
                                      }} />
                              `}
                    </article>
                </section>

                <section className="gallery-section gallery-browse-panel" aria-label="Browse gallery views">
                    <div className="gallery-browse-topline">
                        <div className="gallery-browse-heading">
                            <span className="gallery-kicker">Explore</span>
                            <h2 className="gallery-section-title">Browse</h2>
                        </div>
                        <span className="gallery-chip gallery-browse-summary">
                            ${formatNumber(filteredPhotos.length)} result${filteredPhotos.length === 1 ? '' : 's'}
                        </span>
                    </div>
                    <div className="gallery-browse-controls">
                        <div className="gallery-search gallery-browse-search">
                            ${html`<${Icon} path="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" size=${18} />`}
                            <input
                                type="search"
                                placeholder="Search captions, dates, people"
                                value=${search}
                                onChange=${(event) => setSearch(event.target.value)} />
                        </div>
                        <div className="gallery-browse-toolbar" role="group" aria-label="Browse controls">
                            <div className="gallery-browse-inline-group" role="group" aria-label="View mode">
                                <div className="gallery-segment gallery-browse-segment" role="tablist" aria-label="Gallery layout modes">
                                    ${['highlights', 'days', 'months'].map(
                                        (mode) => html`
                                            <button
                                                type="button"
                                                key=${mode}
                                                className=${cx(viewMode === mode && 'is-active')}
                                                onClick=${() => startTransition(() => setViewMode(mode))}>
                                                ${mode.charAt(0).toUpperCase() + mode.slice(1)}
                                            </button>
                                        `
                                    )}
                                </div>
                            </div>
                            <div className="gallery-browse-inline-group" role="group" aria-label="Theme mode">
                                <div className="gallery-segment gallery-browse-segment" role="tablist" aria-label="Gallery appearance">
                                    ${[
                                        { id: 'auto', label: 'Auto' },
                                        { id: 'light', label: 'Light' },
                                        { id: 'dark', label: 'Dark' }
                                    ].map(
                                        (option) => html`
                                            <button
                                                type="button"
                                                key=${option.id}
                                                className=${cx(themeMode === option.id && 'is-active')}
                                                aria-pressed=${themeMode === option.id ? 'true' : 'false'}
                                                onClick=${() => setThemeMode(option.id)}>
                                                ${option.label}
                                            </button>
                                        `
                                    )}
                                </div>
                            </div>
                            <div className="gallery-browse-inline-group" role="group" aria-label="Slideshow order">
                                <div className="gallery-segment gallery-browse-segment" role="tablist" aria-label="Slideshow order">
                                    ${[
                                        { id: 'latest', label: 'Latest' },
                                        { id: 'pinned', label: 'Pinned' },
                                        { id: 'shuffle', label: 'Shuffle' }
                                    ].map(
                                        (option) => html`
                                            <button
                                                type="button"
                                                key=${option.id}
                                                className=${cx(slideshowOrderMode === option.id && 'is-active')}
                                                aria-pressed=${slideshowOrderMode === option.id ? 'true' : 'false'}
                                                onClick=${() => setSlideshowOrderMode(option.id)}>
                                                ${option.label}
                                            </button>
                                        `
                                    )}
                                </div>
                            </div>
                            <div className="gallery-browse-inline-group" role="group" aria-label="Slideshow media">
                                <div className="gallery-segment gallery-browse-segment" role="tablist" aria-label="Slideshow media filter">
                                    ${[
                                        { id: 'all', label: 'All' },
                                        { id: 'images', label: 'Images' },
                                        { id: 'videos', label: 'Videos' }
                                    ].map(
                                        (option) => html`
                                            <button
                                                type="button"
                                                key=${option.id}
                                                className=${cx(slideshowMediaFilter === option.id && 'is-active')}
                                                aria-pressed=${slideshowMediaFilter === option.id ? 'true' : 'false'}
                                                onClick=${() => setSlideshowMediaFilter(option.id)}>
                                                ${option.label}
                                            </button>
                                        `
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
                ${(statusMessage || errorMessage)
                    ? html`
                          <div className=${cx('gallery-status', errorMessage && 'error')}>
                              ${errorMessage
                                  ? html`<${Icon} path="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94A2 2 0 0 0 22.18 18L13.71 3.86a2 2 0 0 0-3.42 0Z" />`
                                  : html`<${Icon} path="M20 6 9 17l-5-5" />`}
                              <span>${errorMessage || statusMessage}</span>
                          </div>
                      `
                    : null}

                <section className="gallery-view">
                    ${loading
                        ? html`
                              <div className="gallery-status">
                                  <span>Refreshing gallery...</span>
                              </div>
                          `
                        : null}

                    ${!loading && !filteredPhotos.length
                        ? html`<${EmptyState} currentUser=${currentUser} onUpload=${() => setUploadOpen(true)} />`
                        : null}

                    ${!loading && filteredPhotos.length && viewMode === 'highlights'
                        ? html`
                              <section className="gallery-section">
                                  <div className="gallery-section-header">
                                      <div>
                                          <h2 className="gallery-section-title">Highlights</h2>
                                          <p className="gallery-section-meta">
                                              A quick look at the newest uploads.
                                          </p>
                                      </div>
                                      <span className="gallery-chip">${filteredPhotos.length} items</span>
                                  </div>
                                  <${PreviewGrid}
                                      photos=${filteredPhotos}
                                      onOpenPhoto=${setActivePhotoId}
                                      onOpenMore=${() =>
                                          openSectionBrowser({
                                              key: 'highlights-all',
                                              title: 'Highlights',
                                              subtitle: 'All visible items',
                                              photos: filteredPhotos
                                          })} />
                              </section>

                              ${daySections.slice(0, 3).map(
                                  (section) => html`
                                      <section className="gallery-section" key=${section.key}>
                                          <div className="gallery-section-header">
                                              <div>
                                                  <h2 className="gallery-section-title">${section.title}</h2>
                                                  <p className="gallery-section-meta">${section.subtitle}</p>
                                              </div>
                                              <span className="gallery-chip">${section.photos.length} items</span>
                                          </div>
                                          <${PreviewGrid}
                                              photos=${section.photos}
                                              onOpenPhoto=${setActivePhotoId}
                                              onOpenMore=${() => openSectionBrowser(section)} />
                                      </section>
                                  `
                              )}
                          `
                        : null}

                    ${!loading && filteredPhotos.length && viewMode === 'days'
                        ? html`
                              ${visibleDaySections.map(
                                  (section) => html`
                                      <section className="gallery-section" key=${section.key}>
                                          <div className="gallery-section-header">
                                              <div>
                                                  <h2 className="gallery-section-title">${section.title}</h2>
                                                  <p className="gallery-section-meta">${section.subtitle}</p>
                                              </div>
                                              <span className="gallery-chip">${section.photos.length} items</span>
                                          </div>
                                          <${PreviewGrid}
                                              photos=${section.photos}
                                              onOpenPhoto=${setActivePhotoId}
                                              onOpenMore=${() => openSectionBrowser(section)} />
                                      </section>
                                  `
                              )}
                              ${hasMoreGalleryContent
                                  ? html`
                                        <${LoadMoreSentinel}
                                            busy=${loadingMorePhotos}
                                            disabled=${!hasMoreGalleryContent}
                                            label=${loadMoreLabel}
                                            busyLabel="Loading more memories..."
                                            onLoadMore=${handleNeedMoreGalleryContent} />
                                    `
                                  : null}
                          `
                        : null}

                    ${!loading && filteredPhotos.length && viewMode === 'months'
                        ? html`
                              ${visibleMonthSections.map(
                                  (section) => html`
                                      <section className="gallery-section" key=${section.key}>
                                          <div className="gallery-section-header">
                                              <div>
                                                  <h2 className="gallery-section-title">${section.title}</h2>
                                                  <p className="gallery-section-meta">
                                                      ${section.photos.length} item${section.photos.length === 1 ? '' : 's'} captured this month
                                                  </p>
                                              </div>
                                              <span className="gallery-chip">${section.photos.length} items</span>
                                          </div>
                                          <${PreviewGrid}
                                              photos=${section.photos}
                                              onOpenPhoto=${setActivePhotoId}
                                              onOpenMore=${() => openSectionBrowser(section)} />
                                      </section>
                                  `
                              )}
                              ${hasMoreGalleryContent
                                  ? html`
                                        <${LoadMoreSentinel}
                                            busy=${loadingMorePhotos}
                                            disabled=${!hasMoreGalleryContent}
                                            label=${loadMoreLabel}
                                            busyLabel="Loading more memories..."
                                            onLoadMore=${handleNeedMoreGalleryContent} />
                                    `
                                  : null}
                          `
                        : null}
                </section>
            </main>

            ${uploadOpen
                ? html`
                      <${UploadModal}
                          currentUser=${currentUser}
                          draft=${uploadDraft}
                          busy=${uploadBusy}
                          errorMessage=${uploadErrorMessage}
                          progress=${uploadProgress}
                          onClose=${() => {
                              if (uploadBusy) return;
                              setUploadOpen(false);
                              resetUploadFeedback();
                          }}
                          onFilesSelected=${handleFilesSelected}
                          onRemoveFile=${removeDraftFile}
                          onFieldChange=${updateDraftField}
                          onUpload=${handleUpload} />
                  `
                : null}

            ${activePhoto
                ? html`
                      <${Lightbox}
                          photo=${activePhoto}
                          canDelete=${canDelete}
                          canFeature=${canFeature}
                          deleting=${deleteBusy}
                          featuring=${featureBusy}
                          downloading=${downloadBusy}
                          onClose=${() => setActivePhotoId(null)}
                          onRequestDelete=${requestDeleteActivePhoto}
                          onRequestDownload=${requestDownloadActivePhoto}
                          onToggleFeatured=${handleToggleFeaturedActivePhoto}
                          onNext=${() => moveSelection(1)}
                          onPrev=${() => moveSelection(-1)} />
                  `
                : null}

            ${confirmAction
                ? html`
                      <${ConfirmActionModal}
                          action=${confirmAction}
                          busy=${deleteBusy || downloadBusy}
                          onCancel=${closeConfirmAction}
                          onConfirm=${handleConfirmAction} />
                  `
                : null}

            ${sectionBrowser
                ? html`
                      <${SectionBrowserModal}
                          section=${sectionBrowser}
                          onClose=${() => setSectionBrowser(null)}
                          onOpenPhoto=${setActivePhotoId} />
                  `
                : null}
        </div>
    `;
}

createRoot(document.getElementById('gallery-root')).render(html`<${App} />`);
