const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.TMDB_READ_TOKEN = "test-read-token";

const catalogHandler = require("../api/catalog");
const {playerUrl} = require("../api/play");
const {collectionRequest, rotatingCollections} = catalogHandler;
const root = path.join(__dirname, "..");

function responseRecorder() {
  return {
    statusCode:200,
    headers:{},
    payload:null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    end() { return this; }
  };
}

function tmdbItem(id, title, type = "movie", genreIds = [28]) {
  return type === "tv"
    ? {id, name:title, media_type:"tv", first_air_date:"2025-01-01", poster_path:`/${id}.jpg`, backdrop_path:`/${id}-backdrop.jpg`, overview:`Overview ${id}`, genre_ids:genreIds}
    : {id, title, media_type:"movie", release_date:"2025-01-01", poster_path:`/${id}.jpg`, backdrop_path:`/${id}-backdrop.jpg`, overview:`Overview ${id}`, genre_ids:genreIds};
}

test("browse collections use allowlisted TMDB endpoints and filters", () => {
  assert.deepEqual(collectionRequest("movie", "new", 3), {
    type:"movie", filter:"new", label:"New", path:"/movie/now_playing", params:{page:3}
  });
  assert.equal(collectionRequest("tv", "top_rated", 2).path, "/tv/top_rated");
  assert.equal(collectionRequest("movie", "horror", 4).params.with_genres, "27");
  assert.equal(collectionRequest("tv", "science_fiction", 1).params.with_genres, "10765");
  assert.equal(collectionRequest("movie", "not-real", 1).filter, "popular");
});

test("rotating homepage collections are stable for a day and change the next day", () => {
  const first = rotatingCollections(new Date("2026-09-11T01:00:00Z"));
  const later = rotatingCollections(new Date("2026-09-11T23:59:00Z"));
  const next = rotatingCollections(new Date("2026-09-12T01:00:00Z"));
  assert.deepEqual(first, later);
  assert.notDeepEqual(first, next);
  assert.equal(first.length, 2);
});

test("homepage rows come from distinct feeds and remove cross-row duplicates", async () => {
  catalogHandler.catalogCache.clear();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    const type = parsed.pathname.includes("/tv") || parsed.pathname === "/3/discover/tv" ? "tv" : "movie";
    const seed = calls.length * 1000;
    const shared = tmdbItem(99, "Shared title", type);
    return {ok:true, json:async () => ({results:[shared, ...Array.from({length:19}, (_, index) => tmdbItem(seed + index, `Feed ${seed} title ${index}`, type))]})};
  };
  try {
    const response = responseRecorder();
    await catalogHandler({method:"GET", headers:{}, query:{mode:"home"}}, response);
    assert.equal(response.statusCode, 200);
    assert.ok(response.payload.rows.length >= 5);
    assert.ok(response.payload.featured?.backdrop);
    const keys = response.payload.rows.flatMap((row) => row.items.map((item) => `${item.type}:${item.id}`));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(calls.includes("/3/trending/all/day"));
    assert.ok(calls.includes("/3/movie/now_playing"));
    assert.ok(calls.includes("/3/tv/on_the_air"));
    assert.ok(calls.includes("/3/movie/top_rated"));
    assert.ok(calls.includes("/3/tv/top_rated"));
    assert.ok(calls.some((path) => path.startsWith("/3/discover/")));
  } finally {
    global.fetch = originalFetch;
    catalogHandler.catalogCache.clear();
  }
});

test("movie and series browsing use TMDB pages beyond the homepage titles", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({url:String(url), auth:options.headers.Authorization});
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page") || 1);
    const type = parsed.pathname.includes("/tv/") ? "tv" : "movie";
    const start = page * 1000;
    return {ok:true, json:async () => ({results:Array.from({length:20}, (_, index) => tmdbItem(start + index, `${type} page ${page} title ${index}`, type))})};
  };

  try {
    for (const type of ["movie", "tv"]) {
      for (const page of [1, 2]) {
        const response = responseRecorder();
        await catalogHandler({method:"GET", headers:{}, query:{type, page:String(page)}}, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.results.length, 20);
        assert.equal(response.payload.page, page);
        assert.ok(response.payload.results.every((item) => item.type === type && item.poster.includes("image.tmdb.org")));
      }
    }
    assert.ok(calls.every((call) => call.auth === "Bearer test-read-token"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("remote search returns poster-backed TMDB results", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ok:true, json:async () => ({results:[tmdbItem(603, "The Matrix")]})});
  try {
    const response = responseRecorder();
    await catalogHandler({method:"GET", headers:{}, query:{mode:"search", q:"matrix"}}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.results[0].id, 603);
    assert.match(response.payload.results[0].poster, /image\.tmdb\.org/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("catalog rejects POST requests and caches repeated TMDB queries", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {ok:true, json:async () => ({results:[tmdbItem(9001, "Cache Test")]})};
  };
  try {
    const rejected = responseRecorder();
    await catalogHandler({method:"POST", headers:{}, query:{type:"movie", page:"77"}}, rejected);
    assert.equal(rejected.statusCode, 405);
    assert.equal(calls, 0);

    for (let index = 0; index < 2; index += 1) {
      const response = responseRecorder();
      await catalogHandler({method:"GET", headers:{}, query:{type:"movie", page:"77"}}, response);
      assert.equal(response.statusCode, 200);
    }
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("movie and series selections produce the unchanged Videasy player URLs", () => {
  assert.equal(playerUrl({id:603, type:"movie"}), "https://player.videasy.to/movie/603?overlay=true");
  assert.equal(playerUrl({id:1399, type:"tv", season:2, episode:4}), "https://player.videasy.to/tv/1399/2/4?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true");
});

test("catalog UI keeps browse filters and device-local playback history separate from payments", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /data-catalog-filter="popular"/);
  assert.match(html, /data-catalog-filter="top_rated"/);
  assert.match(html, /data-catalog-filter="horror"/);
  assert.match(app, /filter:browseFilter/);
  assert.match(app, /sandboxed-recent-items:/);
  assert.match(app, /Because You Watched/);
  assert.match(app, /rememberPlayed\(item\)/);
  assert.doesNotMatch(app, /STRIPE_|NOWPAYMENTS_/);
});
