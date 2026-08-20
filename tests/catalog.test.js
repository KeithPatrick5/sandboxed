const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TMDB_READ_TOKEN = "test-read-token";

const catalogHandler = require("../api/catalog");
const {playerUrl} = require("../api/play");

function responseRecorder() {
  return {
    statusCode:200,
    headers:{},
    payload:null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

function tmdbItem(id, title, type = "movie") {
  return type === "tv"
    ? {id, name:title, media_type:"tv", first_air_date:"2025-01-01", poster_path:`/${id}.jpg`, backdrop_path:`/${id}-backdrop.jpg`}
    : {id, title, media_type:"movie", release_date:"2025-01-01", poster_path:`/${id}.jpg`, backdrop_path:`/${id}-backdrop.jpg`};
}

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
        await catalogHandler({query:{type, page:String(page)}}, response);
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
    await catalogHandler({query:{mode:"search", q:"matrix"}}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.results[0].id, 603);
    assert.match(response.payload.results[0].poster, /image\.tmdb\.org/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("movie and series selections produce the unchanged Videasy player URLs", () => {
  assert.equal(playerUrl({id:603, type:"movie"}), "https://player.videasy.to/movie/603?overlay=true");
  assert.equal(playerUrl({id:1399, type:"tv", season:2, episode:4}), "https://player.videasy.to/tv/1399/2/4?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true");
});
