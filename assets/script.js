/* ============================================================
   Wave Logging — Frontend
   - View switching (landing → bot view)
   - Tab rendering (per bot, per category)
   - JSON loading (today's deltas via _manifest.json + rolled days)
   - Guild filter, search, click-to-expand, pagination
   - Auto-refresh every 5 min
   - XSS-safe (textContent everywhere, no innerHTML with user data)
   ============================================================ */

"use strict";

// ──────────────────────────────────────────────────────────────
// Tab definitions per bot section. Slugs must match what the
// bot-side global_logger.log_event() passes as `category`.
// ──────────────────────────────────────────────────────────────
const TABS = {
  manager: [
    { slug: "commands",                 label: "Commands" },
    { slug: "errors",                   label: "Errors" },
    { slug: "rate_limits",              label: "Rate Limits" },
    { slug: "vbucks",                   label: "VBucks" },
    { slug: "strikes",                  label: "Strikes" },
    { slug: "drop_maps",                label: "Drop Maps" },
    { slug: "loot_routes",              label: "Loot Routes" },
    { slug: "wave_points",              label: "Wave Points" },
    { slug: "goals_phour_predictions",  label: "Goals · Power Hour · Predictions" },
    { slug: "reviewing",                label: "Reviewing" },
    { slug: "dms_sent",                 label: "DMs Sent" },
    { slug: "database_ops",             label: "Database Ops" },
    { slug: "bot_lifecycle",            label: "Bot Lifecycle" },
  ],
  server: [
    { slug: "member_joins",          label: "Member Joins" },
    { slug: "member_leaves",         label: "Member Leaves" },
    { slug: "bans_kicks_timeouts",   label: "Bans · Kicks · Timeouts" },
    { slug: "role_changes",          label: "Role Changes" },
    { slug: "nicknames",             label: "Nicknames" },
    { slug: "channel_creates",       label: "Channel Creates" },
    { slug: "channel_deletes",       label: "Channel Deletes" },
    { slug: "channel_edits",         label: "Channel Edits" },
    { slug: "role_create_delete",    label: "Role Create / Delete" },
    { slug: "voice_activity",        label: "Voice Activity" },
    { slug: "soundboard",            label: "Soundboard" },
    { slug: "message_deletes",       label: "Message Deletes" },
    { slug: "message_edits",         label: "Message Edits" },
    { slug: "server_settings",       label: "Server Settings" },
    { slug: "emoji_sticker",         label: "Emoji / Sticker" },
    { slug: "invites",               label: "Invites" },
  ],
  logistics: [
    { slug: "commands",              label: "Commands" },
    { slug: "errors",                label: "Errors" },
    { slug: "map_queue",             label: "Map Queue" },
    { slug: "priority_tracking",     label: "Priority Tracking" },
    { slug: "contributor_tracking",  label: "Contributor Tracking" },
    { slug: "streaks",               label: "Streaks" },
    { slug: "antinuke",              label: "AntiNuke" },
    { slug: "dm_queue",              label: "DM Queue" },
    { slug: "tippy_activity",        label: "Tippy Activity" },
    { slug: "bot_lifecycle",         label: "Bot Lifecycle" },
  ],
};

const SECTION_TITLES = {
  manager:   "Wave Manager",
  server:    "Server Events",
  logistics: "Wave Logistics",
};

const PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 5 * 60 * 1000;

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
const state = {
  currentSection: null,    // "manager" | "server" | "logistics"
  currentTab: null,        // slug
  guildFilter: "all",
  searchText: "",
  allEvents: [],           // events for current tab, sorted desc by ts
  visibleCount: PAGE_SIZE,
  guilds: [],              // [{id, name}]
  autoRefreshTimer: null,
};

// ──────────────────────────────────────────────────────────────
// Element shortcuts
// ──────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = {
  landing:        () => $("#landing"),
  botView:        () => $("#bot-view"),
  backBtn:        () => $("#back-btn"),
  botViewTitle:   () => $("#bot-view-title"),
  tabBar:         () => $("#tab-bar"),
  eventList:      () => $("#event-list"),
  visibleCount:   () => $("#visible-count"),
  loading:        () => $("#loading-indicator"),
  loadMoreBtn:    () => $("#load-more-btn"),
  emptyState:     () => $("#empty-state"),
  searchBox:      () => $("#search-box"),
  guildFilter:    () => $("#guild-filter"),
  refreshBtn:     () => $("#refresh-btn"),
  lastUpdate:     () => $("#last-update"),
  guildCount:     () => $("#guild-count"),
};

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Tile clicks
  document.querySelectorAll(".tile").forEach(tile => {
    tile.addEventListener("click", () => openSection(tile.dataset.target));
  });
  el.backBtn().addEventListener("click", showLanding);
  el.searchBox().addEventListener("input", onSearchChange);
  el.guildFilter().addEventListener("change", onGuildFilterChange);
  el.refreshBtn().addEventListener("click", () => loadTab(state.currentTab, { force: true }));
  el.loadMoreBtn().addEventListener("click", showMoreRows);

  loadGuilds().then(renderLandingStats);
});

// ──────────────────────────────────────────────────────────────
// View switching
// ──────────────────────────────────────────────────────────────
function showLanding() {
  el.botView().classList.remove("active");
  el.landing().classList.add("active");
  state.currentSection = null;
  state.currentTab = null;
  stopAutoRefresh();
  renderLandingStats();
}

function openSection(sectionSlug) {
  if (!TABS[sectionSlug]) return;
  el.landing().classList.remove("active");
  el.botView().classList.add("active");
  state.currentSection = sectionSlug;
  el.botViewTitle().textContent = SECTION_TITLES[sectionSlug];
  renderGuildFilter();
  renderTabs(sectionSlug);
  // Auto-open first tab
  const firstTab = TABS[sectionSlug][0];
  if (firstTab) loadTab(firstTab.slug);
  startAutoRefresh();
}

// ──────────────────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────────────────
function renderTabs(sectionSlug) {
  const bar = el.tabBar();
  bar.innerHTML = "";
  TABS[sectionSlug].forEach(t => {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.dataset.slug = t.slug;
    btn.textContent = t.label;
    btn.addEventListener("click", () => loadTab(t.slug));
    bar.appendChild(btn);
  });
}

function setActiveTab(slug) {
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b.dataset.slug === slug);
  });
}

// ──────────────────────────────────────────────────────────────
// Data loading
// ──────────────────────────────────────────────────────────────
async function loadTab(tabSlug, opts = {}) {
  if (!tabSlug) return;
  state.currentTab = tabSlug;
  state.visibleCount = PAGE_SIZE;
  setActiveTab(tabSlug);

  el.loading().classList.remove("hidden");
  el.eventList().innerHTML = "";
  el.emptyState().classList.add("hidden");
  el.loadMoreBtn().classList.add("hidden");

  try {
    state.allEvents = await fetchEventsForTab(state.currentSection, tabSlug);
  } catch (err) {
    console.error("[wave-logging] loadTab error:", err);
    state.allEvents = [];
  }

  el.loading().classList.add("hidden");
  renderEvents();
  updateLastUpdated();
}

/**
 * Fetch all events for one bot+category by walking:
 *   1. data/<bot>/<category>/<today>/_manifest.json → list of delta files for today
 *   2. data/<bot>/<category>/<today>/<delta>.json for each one
 *   3. data/<bot>/<category>/<yesterday>.json (rolled-up file)
 *
 * For "all forever", we'd also load older days — but to keep the
 * initial page fast we currently load: today's deltas + last 14 days
 * of rolled-up files. Older days could be loaded on demand later.
 */
async function fetchEventsForTab(section, category) {
  const today = utcDateStr(new Date());
  const events = [];

  // 1. Today's deltas
  const manifestUrl = `data/${section}/${category}/${today}/_manifest.json?t=${Date.now()}`;
  const manifest = await safeFetchJson(manifestUrl);
  if (manifest && Array.isArray(manifest.files)) {
    for (const fname of manifest.files) {
      const deltaUrl = `data/${section}/${category}/${today}/${fname}?t=${Date.now()}`;
      const delta = await safeFetchJson(deltaUrl);
      if (delta && Array.isArray(delta.events)) {
        events.push(...delta.events);
      }
    }
  }

  // 2. Last 14 days of rolled-up files (older days available later via picker)
  for (let i = 1; i <= 14; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = utcDateStr(d);
    const rolledUrl = `data/${section}/${category}/${day}.json?t=${Date.now()}`;
    const rolled = await safeFetchJson(rolledUrl);
    if (rolled && Array.isArray(rolled.events)) {
      events.push(...rolled.events);
    }
  }

  // Sort newest first
  events.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return events;
}

async function safeFetchJson(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────
function getFilteredEvents() {
  let evs = state.allEvents;
  if (state.guildFilter !== "all") {
    evs = evs.filter(e => String(e.guild_id || "") === state.guildFilter);
  }
  if (state.searchText) {
    const needle = state.searchText.toLowerCase();
    evs = evs.filter(e => JSON.stringify(e).toLowerCase().includes(needle));
  }
  return evs;
}

function renderEvents() {
  const list = el.eventList();
  list.innerHTML = "";
  const filtered = getFilteredEvents();
  const visible = filtered.slice(0, state.visibleCount);

  el.visibleCount().textContent = String(visible.length);

  if (filtered.length === 0) {
    el.emptyState().classList.remove("hidden");
    el.loadMoreBtn().classList.add("hidden");
    return;
  }
  el.emptyState().classList.add("hidden");

  for (const event of visible) {
    list.appendChild(makeEventRow(event));
  }

  if (filtered.length > visible.length) {
    el.loadMoreBtn().classList.remove("hidden");
    el.loadMoreBtn().textContent = `Load more (${filtered.length - visible.length} remaining)`;
  } else {
    el.loadMoreBtn().classList.add("hidden");
  }
}

function showMoreRows() {
  state.visibleCount += PAGE_SIZE;
  renderEvents();
}

function makeEventRow(event) {
  const row = document.createElement("div");
  row.className = "event-row";

  const summary = document.createElement("div");
  summary.className = "event-row-summary";

  const ts = document.createElement("span");
  ts.className = "event-ts";
  ts.textContent = formatTimestamp(event.timestamp);
  summary.appendChild(ts);

  if (event.guild_name) {
    const guild = document.createElement("span");
    guild.className = "event-guild";
    guild.textContent = event.guild_name;
    summary.appendChild(guild);
  }

  if (event.action) {
    const action = document.createElement("span");
    action.className = "event-action";
    action.textContent = event.action;
    summary.appendChild(action);
  }

  const text = document.createElement("span");
  text.className = "event-summary-text";
  appendSummaryText(text, event);
  summary.appendChild(text);

  row.appendChild(summary);

  const details = document.createElement("div");
  details.className = "event-row-details";
  details.textContent = JSON.stringify(event, null, 2);
  row.appendChild(details);

  row.addEventListener("click", () => row.classList.toggle("expanded"));

  return row;
}

/**
 * Produce a one-line human summary for an event. Uses textContent
 * + appendChild only (no innerHTML with user data) to stay XSS-safe.
 */
function appendSummaryText(container, event) {
  const actorName = event.actor && (event.actor.display_name || event.actor.name);
  const targetName = event.target && (event.target.display_name || event.target.name);

  if (actorName) {
    const a = document.createElement("span");
    a.className = "event-actor";
    a.textContent = "@" + actorName;
    container.appendChild(a);
  }

  // Friendly verb between actor and target — derived from action
  const verb = humanizeAction(event.action);
  if (verb) {
    container.appendChild(document.createTextNode(" " + verb + " "));
  } else {
    container.appendChild(document.createTextNode(" "));
  }

  if (targetName) {
    const t = document.createElement("span");
    t.className = "event-target";
    t.textContent = "@" + targetName;
    container.appendChild(t);
  }

  // Append the most useful one-line detail if any
  const det = event.details || {};
  const hint = pickDetailHint(det);
  if (hint) {
    container.appendChild(document.createTextNode(" · " + hint));
  }
}

function humanizeAction(action) {
  if (!action) return "";
  return action.replace(/_/g, " ");
}

function pickDetailHint(details) {
  // Pick a single most-useful field to inline. Show the rest on expand.
  const preferred = ["command", "channel_name", "role_name", "reason",
                     "amount", "wallet_type", "error_message",
                     "queue_position", "before", "after"];
  for (const key of preferred) {
    if (details[key] != null && details[key] !== "") {
      return `${key}: ${truncate(String(details[key]), 80)}`;
    }
  }
  return "";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatTimestamp(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  } catch (e) {
    return iso;
  }
}

function utcDateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

// ──────────────────────────────────────────────────────────────
// Filters
// ──────────────────────────────────────────────────────────────
function onSearchChange(ev) {
  state.searchText = ev.target.value.trim();
  state.visibleCount = PAGE_SIZE;
  renderEvents();
}

function onGuildFilterChange(ev) {
  state.guildFilter = ev.target.value;
  state.visibleCount = PAGE_SIZE;
  renderEvents();
}

function renderGuildFilter() {
  const sel = el.guildFilter();
  sel.innerHTML = "";

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All guilds";
  sel.appendChild(all);

  for (const g of state.guilds) {
    const opt = document.createElement("option");
    opt.value = String(g.id);
    opt.textContent = g.name;
    sel.appendChild(opt);
  }
  sel.value = state.guildFilter;
}

// ──────────────────────────────────────────────────────────────
// Guilds + landing stats
// ──────────────────────────────────────────────────────────────
async function loadGuilds() {
  const data = await safeFetchJson(`data/guilds.json?t=${Date.now()}`);
  if (data && Array.isArray(data.guilds)) {
    state.guilds = data.guilds;
  }
}

async function renderLandingStats() {
  el.guildCount().textContent = String(state.guilds.length || "—");
  el.lastUpdate().textContent = new Date().toUTCString();
  // Event counts per section: best-effort, no-op if data missing
  // (kept simple to avoid hammering the network on landing)
}

function updateLastUpdated() {
  el.lastUpdate().textContent = new Date().toUTCString();
}

// ──────────────────────────────────────────────────────────────
// Auto-refresh
// ──────────────────────────────────────────────────────────────
function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshTimer = setInterval(() => {
    if (state.currentTab) loadTab(state.currentTab, { force: true });
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}
