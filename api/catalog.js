const TMDB_API_ORIGIN = "https://api.themoviedb.org/3";
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org/t/p";
const {rateLimit} = require("../lib/server");

const catalogCache = new Map();
const MAX_CACHE_ENTRIES = 500;

const BROWSE_COLLECTIONS = Object.freeze({
  movie:Object.freeze({
    popular:{label:"Popular", path:"/movie/popular"},
    new:{label:"New", path:"/movie/now_playing"},
    top_rated:{label:"Top Rated", path:"/movie/top_rated"},
    action:{label:"Action", path:"/discover/movie", params:{with_genres:"28"}},
    comedy:{label:"Comedy", path:"/discover/movie", params:{with_genres:"35"}},
    horror:{label:"Horror", path:"/discover/movie", params:{with_genres:"27"}},
    crime:{label:"Crime", path:"/discover/movie", params:{with_genres:"80"}},
    science_fiction:{label:"Science Fiction", path:"/discover/movie", params:{with_genres:"878"}},
    documentary:{label:"Documentary", path:"/discover/movie", params:{with_genres:"99"}},
    family:{label:"Family", path:"/discover/movie", params:{with_genres:"10751"}}
  }),
  tv:Object.freeze({
    popular:{label:"Popular", path:"/tv/popular"},
    new:{label:"New", path:"/tv/on_the_air"},
    top_rated:{label:"Top Rated", path:"/tv/top_rated"},
    action:{label:"Action & Adventure", path:"/discover/tv", params:{with_genres:"10759"}},
    comedy:{label:"Comedy", path:"/discover/tv", params:{with_genres:"35"}},
    horror:{label:"Horror & Mystery", path:"/discover/tv", params:{with_genres:"9648"}},
    crime:{label:"Crime", path:"/discover/tv", params:{with_genres:"80"}},
    science_fiction:{label:"Sci-Fi & Fantasy", path:"/discover/tv", params:{with_genres:"10765"}},
    documentary:{label:"Documentary", path:"/discover/tv", params:{with_genres:"99"}},
    family:{label:"Family", path:"/discover/tv", params:{with_genres:"10751"}}
  })
});

const ROTATING_COLLECTIONS = Object.freeze([
  {title:"Action Night", type:"movie", filter:"action"},
  {title:"Need a Laugh?", type:"movie", filter:"comedy"},
  {title:"Late-Night Horror", type:"movie", filter:"horror"},
  {title:"Crime Stories", type:"tv", filter:"crime"},
  {title:"Sci-Fi Worlds", type:"tv", filter:"science_fiction"},
  {title:"True Stories", type:"movie", filter:"documentary"},
  {title:"Family Night", type:"movie", filter:"family"}
]);

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
    overview:String(item.overview || "").slice(0, 600),
    genreIds:(Array.isArray(item.genre_ids) ? item.genre_ids : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 8)
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

function dailyIndex(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000);
}

function rotatingCollections(date = new Date()) {
  const offset = dailyIndex(date) % ROTATING_COLLECTIONS.length;
  return [
    ROTATING_COLLECTIONS[offset],
    ROTATING_COLLECTIONS[(offset + 3) % ROTATING_COLLECTIONS.length]
  ];
}

function takeUnseen(items, seen, maximum = 16) {
  const selected = [];
  for (const item of unique(items)) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function collectionRequest(type, filter, page = 1) {
  const normalizedType = type === "tv" ? "tv" : "movie";
  const collections = BROWSE_COLLECTIONS[normalizedType];
  const key = Object.hasOwn(collections, filter) ? filter : "popular";
  const collection = collections[key];
  const discover = collection.path.startsWith("/discover/");
  return {
    type:normalizedType,
    filter:key,
    label:collection.label,
    path:collection.path,
    params:{
      page,
      ...(discover ? {sort_by:"popularity.desc", "vote_count.gte":normalizedType === "tv" ? 20 : 100} : {}),
      ...(collection.params || {})
    }
  };
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
  const filter = String(request.query?.filter || "popular").toLowerCase();
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
      const day = new Date().toISOString().slice(0, 10);
      const payload = await cached(`home:${day}`, 1800, async () => {
        const rotating = rotatingCollections();
        const rotatingRequests = rotating.map((entry) => collectionRequest(entry.type, entry.filter));
        const homeRequests = await Promise.allSettled([
          tmdb("/trending/all/day"),
          tmdb("/movie/now_playing", {page:1}),
          tmdb("/tv/on_the_air", {page:1}),
          tmdb("/movie/top_rated", {page:1}),
          tmdb("/tv/top_rated", {page:1}),
          ...rotatingRequests.map((entry) => tmdb(entry.path, entry.params))
        ]);
        const failures = homeRequests.filter((entry) => entry.status === "rejected").length;
        if (failures) console.warn("[api/catalog] Some homepage collections were unavailable", {failures});
        const [trending, newMovies, newShows, topMovies, topShows, ...rotatingPayloads] = homeRequests
          .map((entry) => entry.status === "fulfilled" ? entry.value : {results:[]});
        const trendingItems = results(trending);
        const seen = new Set();
        const rowSources = [
          {title:"Trending Today", note:"Updated today", items:trendingItems},
          {title:"New Movies", items:results(newMovies, "movie")},
          {title:"New & Airing Series", items:results(newShows, "tv")},
          {title:"Top-Rated Movies", items:results(topMovies, "movie")},
          {title:"Top-Rated Series", items:results(topShows, "tv")},
          ...rotating.map((entry, index) => ({
            title:entry.title,
            items:results(rotatingPayloads[index], entry.type)
          }))
        ];
        const rows = rowSources
          .map((row) => ({...row, items:takeUnseen(row.items, seen)}))
          .filter((row) => row.items.length);
        const heroCandidates = trendingItems.filter((item) => item.backdrop && item.overview).slice(0, 10);
        const featured = heroCandidates.length ? heroCandidates[dailyIndex() % heroCandidates.length] : trendingItems[0] || null;
        return {mode, featured, rows, results:unique(rows.flatMap((row) => row.items))};
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

    const collection = collectionRequest(type, filter, page);
    const payload = await cached(`browse:${collection.type}:${collection.filter}:${page}`, 1800, async () => {
      const remote = await tmdb(collection.path, collection.params);
      return {mode, type:collection.type, filter:collection.filter, label:collection.label, page, results:results(remote, collection.type)};
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
module.exports.BROWSE_COLLECTIONS = BROWSE_COLLECTIONS;
module.exports.rotatingCollections = rotatingCollections;
module.exports.collectionRequest = collectionRequest;
