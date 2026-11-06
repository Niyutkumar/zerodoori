// Talks to YouTube on the server side:
//  - searchVideos(): YouTube Data API v3 search (needs YOUTUBE_API_KEY, free quota ~100 searches/day)
//  - videoInfo():    title + channel for a pasted link, via YouTube's public oEmbed (no key needed)
// Results are cached so repeated searches don't use up the daily quota.

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const INFO_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 300;

const searchCache = new Map();
const infoCache = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  while (map.size > MAX_CACHE) map.delete(map.keys().next().value);
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** "PT1H2M3S" -> 3723 */
function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

async function searchVideos(query, { fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY } = {}) {
  if (!apiKey) throw fail('not_configured');
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const cacheKey = q.toLowerCase();
  const cached = cacheGet(searchCache, cacheKey, SEARCH_TTL_MS);
  if (cached) return cached;

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true', // only videos that are allowed to play outside YouTube
    maxResults: '12',
    q,
    key: apiKey,
  });
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw fail('quota');
    if (reason === 'keyInvalid' || res.status === 400) throw fail('bad_key');
    throw fail('failed');
  }
  const data = await res.json();
  const results = (data.items || [])
    .filter((item) => item.id && item.id.videoId)
    .map((item) => {
      const s = item.snippet || {};
      const thumbs = s.thumbnails || {};
      return {
        videoId: item.id.videoId,
        title: decodeEntities(s.title),
        channel: decodeEntities(s.channelTitle),
        thumb: (thumbs.medium && thumbs.medium.url) || `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`,
        live: s.liveBroadcastContent === 'live',
        duration: 0,
      };
    });

  // Video lengths cost only 1 quota unit for all 12, so show them.
  if (results.length) {
    try {
      const p2 = new URLSearchParams({ part: 'contentDetails', id: results.map((r) => r.videoId).join(','), key: apiKey });
      const res2 = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${p2}`, { signal: AbortSignal.timeout(6000) });
      if (res2.ok) {
        const d2 = await res2.json();
        const lengths = new Map((d2.items || []).map((v) => [v.id, parseDuration(v.contentDetails && v.contentDetails.duration)]));
        results.forEach((r) => { r.duration = lengths.get(r.videoId) || 0; });
      }
    } catch (e) { /* lengths are optional */ }
  }

  cacheSet(searchCache, cacheKey, results);
  return results;
}

async function videoInfo(videoId, { fetchImpl = fetch } = {}) {
  if (process.env.ZD_OFFLINE) return { title: null, channel: null }; // used by the offline browser tests
  const cached = cacheGet(infoCache, videoId, INFO_TTL_MS);
  if (cached) return cached;
  let info = { title: null, channel: null };
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      info = { title: data.title || null, channel: data.author_name || null };
      cacheSet(infoCache, videoId, info);
    }
  } catch (e) { /* unknown title is fine */ }
  return info;
}

module.exports = { searchVideos, videoInfo, parseDuration, decodeEntities, _caches: { searchCache, infoCache } };
