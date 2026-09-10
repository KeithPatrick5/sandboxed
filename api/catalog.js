const TMDB_API_ORIGIN = "https://api.themoviedb.org/3";
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org/t/p";
const {rateLimit} = require("../lib/server");

const catalogCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function tmdbCredentials() {
  const readToken = process.env.TMDB_READ_TOKEN?.trim();
  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!readToken && !apiKey) throw new Error("TMDB_READ_TOKEN or TMDB_API_KEY is not configured");
  return {readToken, apiKey};
}

async function tmdb(path, params = {}) {
  const {readToken, apiKey} = tmdbCredentials();
  const url = new URL(`${TMDB_API_ORIGIN}${path}`);
  Object.entries({language:"en-US", include_adult:"false", ...params}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  if (!readToken) url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, {
    headers:{
      accept:"application/json",
      ...(readToken ? {Authorization:`Bearer ${readToken}`} : {})
    },
    signal:AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`TMDB returned ${response.status}`);
  return response.json();
}

function normalize(item, fallbackType) {
  const type = item?.media_type === "tv" || fallbackType === "tv" ? "tv" : item?.media_type === "movie" || fallbackType === "movie" ? "movie" : "";
  const title = type === "tv" ? item?.name : item?.title;
  const id = Number(item?.id);
  if (!type || !Number.isInteger(id) || id < 1 || !title || item?.adult || !item?.poster_path) return null;
  const date = type === "tv" ? item.first_air_date : item.release_date;
  return {
    id,
    type,
    title:String(title).slice(0, 180),
    year:String(date || "").slice(0, 4),
    poster:`${TMDB_IMAGE_ORIGIN}/w500${item.poster_path}`,
    backdrop:item.backdrop_path ? `${TMDB_IMAGE_ORIGIN}/original${item.backdrop_path}` : "",
    overview:String(item.overview || "").slice(0, 600)
  };
}

function results(payload, fallbackType) {
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((item) => normalize(item, fallbackType))
    .filter(Boolean);
}

function unique(items) {
  return [...new Map(items.map((item) => [`${item.type}:${item.id}`, item])).values()];
}

async function cached(cacheKey, ttlSeconds, loader) {
  const now = Date.now();
  const current = catalogCache.get(cacheKey);
  if (current?.payload && current.expiresAt > now) return current.payload;
  if (current?.pending) return current.pending;

  const pending = Promise.resolve().then(loader);
  catalogCache.set(cacheKey, {pending, expiresAt:now + ttlSeconds * 1000});
  try {
    const payload = await pending;
    catalogCache.set(cacheKey, {payload, expiresAt:Date.now() + ttlSeconds * 1000});
    if (catalogCache.size > MAX_CACHE_ENTRIES) {
      for (const [key, entry] of catalogCache) {
        if (entry.expiresAt <= Date.now() || catalogCache.size > MAX_CACHE_ENTRIES) catalogCache.delete(key);
        if (catalogCache.size <= MAX_CACHE_ENTRIES) break;
      }
    }
    return payload;
  } catch (error) {
    if (catalogCache.get(cacheKey)?.pending === pending) catalogCache.delete(cacheKey);
    throw error;
  }
}

function sendResult(request, response, status, payload) {
  response.status(status);
  if (String(request.method || "GET").toUpperCase() === "HEAD") return response.end();
  return response.json(payload);
}

module.exports = async function handler(request, response) {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Cache-Control", "no-store");
    return response.status(405).json({error:"Method not allowed"});
  }
  const mode = request.query?.mode === "search" ? "search" : request.query?.mode === "home" ? "home" : "browse";
  const type = request.query?.type === "tv" ? "tv" : "movie";
  const page = Math.min(500, Math.max(1, Number.parseInt(request.query?.page, 10) || 1));
  const query = String(request.query?.q || "").trim().slice(0, 80);

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", mode === "search" ? "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400" : "public, max-age=60, s-maxage=1800, stale-while-revalidate=86400");

  try {
    rateLimit(request, mode === "search" ? "catalog-search" : "catalog-browse", mode === "search" ? 30 : 120, 60);
    if (mode === "search" && query.length < 2) {
      return sendResult(request, response, 400, {error:"Enter at least two characters."});
    }
    if (mode === "home") {
      const payload = await cached("home", 900, async () => {
        const [trending, popularMovies, popularShows] = await Promise.all([
          tmdb("/trending/all/day"),
          tmdb("/movie/popular", {page:1}),
          tmdb("/tv/popular", {page:1})
        ]);
        return {mode, results:unique([
          ...results(trending),
          ...results(popularMovies, "movie"),
          ...results(popularShows, "tv")
        ])};
      });
      return sendResult(request, response, 200, payload);
    }

    if (mode === "search") {
      const payload = await cached(`search:${query.toLowerCase()}`, 3600, async () => {
        const remote = await tmdb("/search/multi", {query, page:1});
        return {mode, type:"all", page:1, results:results(remote)};
      });
      return sendResult(request, response, 200, payload);
    }

    const payload = await cached(`browse:${type}:${page}`, 1800, async () => {
      const remote = await tmdb(`/${type}/popular`, {page});
      return {mode, type, page, results:results(remote, type)};
    });
    return sendResult(request, response, 200, payload);
  } catch (error) {
    if (error?.status === 429) {
      response.setHeader("Cache-Control", "no-store");
      if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
      return sendResult(request, response, 429, {error:error.message, code:error.code});
    }
    console.error("[api/catalog]", {mode, type, page, message:String(error), stack:error?.stack});
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({error:"TMDB metadata is temporarily unavailable."});
  }
};

module.exports.catalogCache = catalogCache;
