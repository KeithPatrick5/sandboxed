const image = (path) => `https://image.tmdb.org/t/p/w500${path}`;
const CATALOG_SIZE = 100000;

let catalog = [
  [1368337,"The Odyssey","movie",2026,"/5rhTDKUhPYvpdQIijFIs5VoWsON.jpg"],
  [1339713,"Obsession","movie",2026,"/bRwnj8WEKBCvmfeUNOukJPwB43K.jpg"],
  [969681,"Spider-Man: Brand New Day","movie",2026,"/iPOn6DinuVyLY17YM9mKuPofV08.jpg"],
  [1323244,"Rage of Stars","movie",2026,"/oLld47ZT1I3iecM3OWhIphohQUJ.jpg"],
  [1315772,"Minions & Monsters","movie",2026,"/4LwvU9SZc8QQzW1X1FAPhNbXnEU.jpg"],
  [1375646,"Colony","movie",2026,"/tN799oUR0f1gUKDYdMNrDaY7I51.jpg"],
  [1084244,"Toy Story 5","movie",2026,"/sfQtVlIHljToOwYjhe21KPGzZWK.jpg"],
  [1284041,"The Last House","movie",2026,"/6JU7E8Vv2M11egkctWVOScxWR75.jpg"],
  [1284465,"The Death of Robin Hood","movie",2026,"/92Tsfx7SFafOqWsotvrlJbHyehd.jpg"],
  [1101383,"The End of Oak Street","movie",2026,"/fYXqpgPmHMphSF2W30GbTeJVIa5.jpg"],
  [1212763,"Evil Dead Burn","movie",2026,"/uRxrNXQWkHoENm3nwVOZDYSCx2F.jpg"],
  [1108427,"Moana","movie",2026,"/zKVgiv5qHCvCLT4A2ymJi5QeXDH.jpg"],
  [1275779,"Disclosure Day","movie",2026,"/AnJ8IQJI23hNpYXVNaythu061Ru.jpg"],
  [1081003,"Supergirl","movie",2026,"/1QCWdqzTfh2x9UylVpspIU6QTuM.jpg"],
  [1307118,"Soulm8te","movie",2026,"/bNErActDctl6cdUGw9pnjSCmyhQ.jpg"],
  [1083381,"Backrooms","movie",2026,"/rhGx6E3qRNMgj3i5su2oukNHwIQ.jpg"],
  [1273221,"Scary Movie","movie",2026,"/znHT8peERZRWG1ME3r0Db0EV8k8.jpg"],
  [108978,"Reacher","tv",2022,"/f1VCQIG2iCyOookdgOzwtUpwWC0.jpg"],
  [113962,"Lioness","tv",2023,"/rzpHPSEgPTpRs8EHbygwsOw7jC0.jpg"],
  [5920,"The Mentalist","tv",2008,"/acYXu4KaDj1NIkMgObnhe4C4a0T.jpg"],
  [94997,"House of the Dragon","tv",2022,"/7V0Ebks0GgpKvQ7QbLAIdX5dos4.jpg"],
  [95350,"Lanterns","tv",2026,"/gpC7h43xPMEV3goYMQShfJbTtLq.jpg"],
  [125988,"Silo","tv",2023,"/gMYZZvnkVNTqSVnVCphWbPXwWwb.jpg"],
  [79744,"The Rookie","tv",2018,"/70kTz0OmjjZe7zHvIDrq2iKW7PJ.jpg"],
  [456,"The Simpsons","tv",1989,"/uWpG7GqfKGQqX4YMAo3nv5OrglV.jpg"],
  [1434,"Family Guy","tv",1999,"/3PFsEuAiyLkWsP4GG6dIV37Q6gu.jpg"],
  [4614,"NCIS","tv",2003,"/mBcu8d6x6zB1el3MPNl7cZQEQ31.jpg"],
  [1622,"Supernatural","tv",2005,"/8iixmfGx5EIFPdpNvB2JvI3VIqX.jpg"],
  [60625,"Rick and Morty","tv",2013,"/owhkU6KRqdXoUQpjV8uyZGPtX58.jpg"],
  [1399,"Game of Thrones","tv",2011,"/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg"],
  [124364,"FROM","tv",2022,"/pRtJagIxpfODzzb0T0NAvZSzErC.jpg"],
  [4057,"Criminal Minds","tv",2005,"/hWSb4UnIjlTvnvrP98NbFSO60HA.jpg"],
  [1408,"House","tv",2004,"/3Cz7ySOQJmqiuTdrc6CY0r65yDI.jpg"]
].map(([id,title,type,year,poster]) => ({id,title,type,year:String(year),poster:image(poster)}));

const featured = {
  ...catalog[0],
  maturity:"PG-13",
  runtime:"2h 35m",
  match:99,
  genres:["Adventure","Action","Fantasy"],
  overview:"Odysseus, the legendary King of Ithaca, begins a dangerous journey home after the Trojan War, facing gods, monsters and impossible trials."
};

function buildHomeRows(items) {
  const pinned = [
    items.find((item) => item.type === "movie" && item.id === 1368337),
    items.find((item) => item.type === "movie" && item.id === 1339713)
  ].filter(Boolean);
  const ordered = [...new Map([...pinned, ...items].map((item) => [`${item.type}:${item.id}`, item])).values()];
  const movies = ordered.filter((item) => item.type === "movie");
  const shows = ordered.filter((item) => item.type === "tv");
  const mixed = [];
  for (let index = 0; index < Math.max(movies.length, shows.length); index += 1) {
    if (movies[index]) mixed.push(movies[index]);
    if (shows[index]) mixed.push(shows[index]);
  }
  return [
    ["Trending Now", ordered.slice(0, 16)],
    ["Movies Everyone’s Watching", movies.slice(0, 16)],
    ["Popular Series", shows.slice(0, 16)],
    ["More to Watch", mixed.slice(10, 26)]
  ];
}

let rows = buildHomeRows(catalog);

const homeView = document.querySelector(".home-view");
const browseView = document.querySelector(".browse-view");
const grid = document.querySelector("#catalog-grid");
const search = document.querySelector("#search-input");
const clearSearch = document.querySelector("#clear-search");
const modal = document.querySelector("#player-modal");
const frame = document.querySelector("#player-frame");
const playerTitle = document.querySelector("#player-title");
const status = document.querySelector("#catalog-status");
const loadMore = document.querySelector("#load-more");
const adNotice = document.querySelector("#playback-notice");
const adHelpModal = document.querySelector("#ad-help-modal");
const adHelpOptions = document.querySelector("#ad-help-options");
const adHelpDevice = document.querySelector("#ad-help-device");

const AD_NOTICE_KEY = "sandboxed-ad-notice-dismissed";
const AD_HELP_LINKS = {
  android: {
    label: "Recommended for Android",
    options: [
      {title:"Install Brave", detail:"Ad blocking is built in", href:"https://play.google.com/store/apps/details?id=com.brave.browser"},
      {title:"Install Firefox", detail:"Then add uBlock Origin", href:"https://www.mozilla.org/firefox/browsers/mobile/android/"},
      {title:"Add uBlock Origin", detail:"Free Firefox extension", href:"https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"}
    ]
  },
  ios: {
    label: "Recommended for iPhone and iPad",
    options: [
      {title:"Install Brave", detail:"Ad blocking is built in", href:"https://apps.apple.com/us/app/brave-browser-search-engine/id1052879175"},
      {title:"Install AdGuard for Safari", detail:"Free Safari content blocker", href:"https://apps.apple.com/us/app/adguard-ad-blocker-for-safari/id1047223162"}
    ]
  },
  desktop: {
    label: "Recommended for computers",
    options: [
      {title:"Download Brave", detail:"Ad blocking is built in", href:"https://brave.com/download/"},
      {title:"Download Firefox", detail:"Then add uBlock Origin", href:"https://www.mozilla.org/firefox/new/"},
      {title:"Add uBlock Origin", detail:"Free Firefox extension", href:"https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"}
    ]
  }
};

let activeTab = "home";
let browseItems = [];
let browsePage = 1;
let requestSerial = 0;
let searchTimer;
let adHelpReturnFocus;

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeItem(item) {
  const id = Number(item?.id);
  const type = item?.type === "tv" ? "tv" : "movie";
  if (!Number.isInteger(id) || id < 1 || !item?.title) return null;
  return {
    id,
    type,
    title: String(item.title).slice(0, 180),
    year: String(item.year || "").slice(0, 4),
    maturity: String(item.maturity || ""),
    runtime: String(item.runtime || ""),
    match: Number(item.match) || 0,
    genres: Array.isArray(item.genres) ? item.genres.map(String).slice(0, 6) : [],
    poster: /^https:\/\/(image|media)\.tmdb\.org\//.test(item.poster || "") ? item.poster : "",
    overview: String(item.overview || "").slice(0, 600)
  };
}

function itemKey(item) { return `${item.type}:${item.id}`; }

const storedItems = safeJson(localStorage.getItem("sandboxed-saved-items") || localStorage.getItem("noctra-saved-items") || "[]", []);
let savedItems = Array.isArray(storedItems) ? storedItems.map(normalizeItem).filter(Boolean) : [];
if (!savedItems.length) {
  const legacyIds = safeJson(localStorage.getItem("noctra-my-list") || "[]", []);
  if (Array.isArray(legacyIds)) savedItems = catalog.filter((item) => legacyIds.includes(item.id));
}

document.querySelector("#hero").style.backgroundImage = "url(https://image.tmdb.org/t/p/original/r57L2UBLPKcHdZQYg8tagv9XqK2.jpg)";

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);
}

function playerUrl(item) {
  return item.type === "movie"
    ? `https://player.videasy.to/movie/${item.id}?overlay=true`
    : `https://player.videasy.to/tv/${item.id}/1/1?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true`;
}

async function play(item) {
  const membership = window.SandboxedMembership;
  const access = membership ? await membership.authorizePlay(item) : {url:null, sessionId:null};
  if (!access) return;
  playerTitle.textContent = item.title;
  frame.src = access.url || playerUrl(item);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  membership?.startHeartbeat(access.sessionId);
}

function closePlayer() {
  window.SandboxedMembership?.stopPlayback();
  modal.hidden = true;
  frame.src = "about:blank";
  document.body.style.overflow = "";
}

function playbackPlatform() {
  const userAgent = navigator.userAgent || "";
  const iPadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(userAgent) || iPadDesktopMode) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

function renderAdHelp() {
  const help = AD_HELP_LINKS[playbackPlatform()];
  adHelpDevice.textContent = help.label;
  adHelpOptions.replaceChildren(...help.options.map((option) => {
    const link = document.createElement("a");
    link.className = "ad-help-option";
    link.href = option.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = `<span><strong>${escapeHtml(option.title)}</strong><small>${escapeHtml(option.detail)}</small></span><b aria-hidden="true">↗</b>`;
    return link;
  }));
}

function openAdHelp(event) {
  adHelpReturnFocus = event?.currentTarget || document.activeElement;
  renderAdHelp();
  adHelpModal.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#close-ad-help").focus();
}

function closeAdHelp() {
  adHelpModal.hidden = true;
  if (modal.hidden) document.body.style.overflow = "";
  adHelpReturnFocus?.focus();
}

function dismissAdNotice() {
  adNotice.hidden = true;
  try { localStorage.setItem(AD_NOTICE_KEY, "1"); } catch {}
}

function isSaved(item) {
  const key = itemKey(item);
  return savedItems.some((saved) => itemKey(saved) === key);
}

function persistSavedItems() {
  localStorage.setItem("sandboxed-saved-items", JSON.stringify(savedItems));
}

function toggleList(item) {
  const key = itemKey(item);
  savedItems = isSaved(item)
    ? savedItems.filter((saved) => itemKey(saved) !== key)
    : [...savedItems, normalizeItem(item)];
  persistSavedItems();
  updateHeroList();
  if (activeTab === "list") {
    browseItems = savedItems;
    renderGrid();
  }
  renderRows();
}

function card(item) {
  const added = isSaved(item);
  const article = document.createElement("article");
  const safeTitle = escapeHtml(item.title);
  const safePoster = escapeHtml(item.poster || "");
  article.className = "media-card";
  article.innerHTML = `<button type="button" class="poster-button" aria-label="Play ${safeTitle}"><span class="poster-fallback">${safeTitle}</span>${safePoster ? `<img src="${safePoster}" alt="${safeTitle} poster" loading="lazy">` : ""}<span class="poster-shade"></span><span class="card-play"><span class="play-triangle"></span></span><span class="card-copy"><strong>${safeTitle}</strong><small>${item.type === "tv" ? "Series" : escapeHtml(item.year || "Movie")}</small></span></button><button type="button" class="list-toggle ${added ? "is-added" : ""}" aria-label="${added ? "Remove" : "Add"} ${safeTitle} ${added ? "from" : "to"} My List">${added ? "✓" : "+"}</button>`;
  article.querySelector(".poster-button").addEventListener("click", () => play(item));
  article.querySelector(".list-toggle").addEventListener("click", () => toggleList(item));
  article.querySelector("img")?.addEventListener("error", (event) => event.currentTarget.remove());
  return article;
}

function renderRows() {
  const target = document.querySelector("#content-rows");
  target.replaceChildren();
  rows.forEach(([title,items],index) => {
    const section = document.createElement("div");
    section.className = "media-row";
    section.innerHTML = `<div class="row-heading"><h2>${title}</h2>${index === 0 ? "<span>Updated today</span>" : ""}</div><div class="card-track"></div>`;
    const track = section.querySelector(".card-track");
    items.forEach((item) => track.append(card(item)));
    target.append(section);
  });
}

function setStatus(message, loading = false) {
  status.textContent = message;
  status.classList.toggle("is-loading", loading);
}

function showEmpty(title, copy) {
  const empty = document.querySelector("#empty-state");
  document.querySelector("#empty-title").textContent = title;
  document.querySelector("#empty-copy").textContent = copy;
  empty.hidden = false;
  grid.hidden = true;
}

function renderGrid() {
  const term = activeTab === "list" ? search.value.trim().toLowerCase() : "";
  const results = term
    ? browseItems.filter((item) => `${item.title} ${item.year}`.toLowerCase().includes(term))
    : browseItems;
  grid.replaceChildren(...results.map(card));
  grid.hidden = results.length === 0;
  document.querySelector("#empty-state").hidden = results.length !== 0;
  if (!results.length) {
    if (activeTab === "list" && !savedItems.length) showEmpty("Your list is empty.", "Tap + on any title to save it here.");
    else if (activeTab === "list") showEmpty(`Nothing found for “${search.value}”.`, "Try another title.");
  }
  clearSearch.hidden = !search.value;
}

async function getCatalog(params) {
  const response = await fetch(`/api/catalog?${new URLSearchParams({...params, v:"2"})}`, {headers:{accept:"application/json"}});
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  return response.json();
}

async function loadHome() {
  try {
    const data = await getCatalog({mode:"home"});
    const incoming = (data.results || []).map(normalizeItem).filter((item) => item?.poster);
    if (incoming.length < 20) return;
    const pinned = catalog.filter((item) => item.type === "movie" && (item.id === 1368337 || item.id === 1339713));
    catalog = [...new Map([...pinned, ...incoming].map((item) => [itemKey(item), item])).values()];
    rows = buildHomeRows(catalog);
    renderRows();
  } catch (error) {
    console.warn("[catalog:home] Using current built-in titles", error);
  }
}

async function loadBrowse(type, append = false) {
  const serial = ++requestSerial;
  const nextPage = append ? browsePage + 1 : 1;
  loadMore.hidden = true;
  if (!append) {
    browseItems = [];
    grid.replaceChildren();
    grid.hidden = true;
  }
  setStatus(append ? "Loading more titles…" : "Loading the catalog…", true);
  try {
    const data = await getCatalog({type, page:String(nextPage)});
    if (serial !== requestSerial || activeTab !== type) return;
    const incoming = (data.results || []).map(normalizeItem).filter((item) => item?.poster);
    const merged = append ? [...browseItems, ...incoming] : incoming;
    browseItems = [...new Map(merged.map((item) => [itemKey(item), item])).values()];
    browsePage = nextPage;
    renderGrid();
    const label = type === "tv" ? "series" : "movies";
    setStatus(`${browseItems.length.toLocaleString()} ${label} loaded • page ${browsePage.toLocaleString()} • posters included`);
    loadMore.hidden = incoming.length < 20;
  } catch (error) {
    if (serial !== requestSerial) return;
    setStatus("");
    showEmpty("Catalog temporarily unavailable.", "Please try again in a moment.");
    console.error("[catalog:browse]", error);
  }
}

async function runSearch(term) {
  const query = term.trim();
  if (query.length < 2) {
    browseItems = [];
    setStatus(`Search ${CATALOG_SIZE.toLocaleString()} movies and series`);
    showEmpty("Search the full catalog.", "Type at least two letters to find a title.");
    return;
  }
  const serial = ++requestSerial;
  grid.replaceChildren();
  grid.hidden = true;
  loadMore.hidden = true;
  document.querySelector("#empty-state").hidden = true;
  setStatus(`Searching for “${query}”…`, true);
  try {
    const data = await getCatalog({mode:"search", q:query});
    if (serial !== requestSerial || search.value.trim() !== query) return;
    let results = (data.results || []).map(normalizeItem).filter((item) => item?.poster);
    if (activeTab === "movies") results = results.filter((item) => item.type === "movie");
    if (activeTab === "tv") results = results.filter((item) => item.type === "tv");
    browseItems = results;
    renderGrid();
    setStatus(`${results.length} result${results.length === 1 ? "" : "s"} for “${query}” • ${Number(data.catalogSize || CATALOG_SIZE).toLocaleString()} titles indexed • posters included`);
    if (!results.length) showEmpty(`Nothing found for “${query}”.`, "Check the spelling or try another title.");
  } catch (error) {
    if (serial !== requestSerial) return;
    setStatus("");
    showEmpty("Search temporarily unavailable.", "Please try again in a moment.");
    console.error("[catalog:search]", error);
  }
}

function updateHeroList() {
  document.querySelector("#hero-list").textContent = isSaved(featured) ? "✓ In My List" : "+ My List";
}

function setTab(tab) {
  clearTimeout(searchTimer);
  requestSerial += 1;
  activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  if (tab === "home") {
    homeView.hidden = false;
    browseView.hidden = true;
  } else {
    homeView.hidden = true;
    browseView.hidden = false;
    search.value = "";
    clearSearch.hidden = true;
    loadMore.hidden = true;
    document.querySelector("#browse-title").textContent = tab === "tv" ? "Series" : tab === "list" ? "My List" : "Movies";
    if (tab === "list") {
      browseItems = savedItems;
      setStatus(`${savedItems.length} saved title${savedItems.length === 1 ? "" : "s"}`);
      renderGrid();
    } else {
      loadBrowse(tab);
    }
  }
  scrollTo({top:0,behavior:"smooth"});
}

function openSearch() {
  clearTimeout(searchTimer);
  requestSerial += 1;
  activeTab = "search";
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.remove("active"));
  homeView.hidden = true;
  browseView.hidden = false;
  document.querySelector("#browse-title").textContent = "Search";
  search.value = "";
  clearSearch.hidden = true;
  loadMore.hidden = true;
  browseItems = [];
  setStatus(`Search ${CATALOG_SIZE.toLocaleString()} movies and series`);
  showEmpty("Search the full catalog.", "Type at least two letters to find a title.");
  setTimeout(() => search.focus(),0);
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
document.querySelector(".search-button").addEventListener("click", openSearch);
search.addEventListener("input", () => {
  clearSearch.hidden = !search.value;
  if (activeTab === "list") {
    browseItems = savedItems;
    renderGrid();
    return;
  }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(search.value), 320);
});
clearSearch.addEventListener("click", () => {
  search.value = "";
  search.focus();
  clearSearch.hidden = true;
  if (activeTab === "movies" || activeTab === "tv") loadBrowse(activeTab);
  else if (activeTab === "list") { browseItems = savedItems; renderGrid(); }
  else runSearch("");
});
loadMore.addEventListener("click", () => {
  if (activeTab === "movies" || activeTab === "tv") loadBrowse(activeTab, true);
});
document.querySelector("#hero-play").addEventListener("click", () => play(featured));
document.querySelector("#hero-list").addEventListener("click", () => toggleList(featured));
document.querySelector("#close-player").addEventListener("click", closePlayer);
document.querySelector("#open-ad-help").addEventListener("click", openAdHelp);
document.querySelector("#footer-ad-help").addEventListener("click", openAdHelp);
document.querySelector("#dismiss-ad-notice").addEventListener("click", dismissAdNotice);
document.querySelector("#close-ad-help").addEventListener("click", closeAdHelp);
adHelpModal.addEventListener("click", (event) => { if (event.target === adHelpModal) closeAdHelp(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!adHelpModal.hidden) closeAdHelp();
  else if (!modal.hidden) closePlayer();
});
window.addEventListener("sandboxed:resume-play", (event) => play(event.detail));

try { adNotice.hidden = localStorage.getItem(AD_NOTICE_KEY) === "1"; } catch {}

updateHeroList();
renderRows();
loadHome();
