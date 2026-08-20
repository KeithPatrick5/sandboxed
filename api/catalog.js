const TMDB_API_ORIGIN = "https://api.themoviedb.org/3";
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org/t/p";
const CATALOG_SIZE = 100000;

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

module.exports = async function handler(request, response) {
  const mode = request.query?.mode === "search" ? "search" : request.query?.mode === "home" ? "home" : "browse";
  const type = request.query?.type === "tv" ? "tv" : "movie";
  const page = Math.min(500, Math.max(1, Number.parseInt(request.query?.page, 10) || 1));
  const query = String(request.query?.q || "").trim().slice(0, 80);

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", mode === "search" ? "s-maxage=86400, stale-while-revalidate=604800" : "s-maxage=1800, stale-while-revalidate=86400");

  if (mode === "search" && query.length < 2) {
    return response.status(400).json({error:"Enter at least two characters."});
  }

  try {
    if (mode === "home") {
      const [trending, popularMovies, popularShows] = await Promise.all([
        tmdb("/trending/all/day"),
        tmdb("/movie/popular", {page:1}),
        tmdb("/tv/popular", {page:1})
      ]);
      const combined = unique([
        ...results(trending),
        ...results(popularMovies, "movie"),
        ...results(popularShows, "tv")
      ]);
      return response.status(200).json({mode, catalogSize:CATALOG_SIZE, results:combined});
    }

    if (mode === "search") {
      const payload = await tmdb("/search/multi", {query, page:1});
      return response.status(200).json({mode, type:"all", page:1, catalogSize:CATALOG_SIZE, results:results(payload)});
    }

    const payload = await tmdb(`/${type}/popular`, {page});
    return response.status(200).json({mode, type, page, catalogSize:CATALOG_SIZE, results:results(payload, type)});
  } catch (error) {
    console.error("[api/catalog]", {mode, type, page, message:String(error), stack:error?.stack});
    return response.status(502).json({error:"TMDB metadata is temporarily unavailable."});
  }
};
