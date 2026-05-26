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
// Tab definitions per bot section.
//
// Each tab is either:
//   { label, actions: ["slug"] }          — simple single-action tab
//   { label, actions: ["a", "b", "c"] }   — group, rendered as a dropdown
//                                            menu with one item per action
// Slugs must match what the bot-side log_event() passes as `category`.
// ──────────────────────────────────────────────────────────────
const TABS = {
  manager: [
    { label: "Commands",                          actions: ["commands"] },
    { label: "Errors",                            actions: ["errors"] },
    { label: "Rate Limits",                       actions: ["rate_limits"] },
    { label: "VBucks",                            actions: ["vbucks"] },
    { label: "Drop Maps",                         actions: ["drop_maps"] },
    { label: "Loot Routes",                       actions: ["loot_routes"] },
    { label: "Wave Points",                       actions: ["wave_points"] },
    { label: "Goals · Power Hour · Predictions",  actions: ["goals_phour_predictions"] },
    { label: "Reviewing",                         actions: ["reviewing"] },
    { label: "DMs Sent",                          actions: ["dms_sent"] },
    { label: "Database Ops",                      actions: ["database_ops"] },
    { label: "Bot Lifecycle",                     actions: ["bot_lifecycle"] },
  ],
  // 16 broad groups, each a dropdown menu containing the specific
  // discord.AuditLogAction slugs (or Gateway-only events) that belong
  // to that family. Clicking the group button shows the merged event
  // stream from ALL its children. Clicking a child filters to just one.
  server: [
    { label: "Member Joins",  actions: ["member_join"] },
    { label: "Member Leaves", actions: ["member_leave"] },
    { label: "Bans · Kicks · Timeouts", actions: [
      "ban", "unban", "kick", "member_prune",
    ]},
    { label: "Role Changes",  actions: ["member_role_update"] },
    { label: "Nicknames",     actions: ["member_update"] },
    { label: "Channel Creates", actions: [
      "channel_create", "thread_create",
    ]},
    { label: "Channel Deletes", actions: [
      "channel_delete", "thread_delete",
    ]},
    { label: "Channel Edits", actions: [
      "channel_update", "thread_update",
      "overwrite_create", "overwrite_update", "overwrite_delete",
      "voice_channel_status_update",
    ]},
    { label: "Role Create / Delete", actions: [
      "role_create", "role_delete", "role_update",
    ]},
    { label: "Voice Activity", actions: [
      "voice_state_changed", "member_move", "member_disconnect",
    ]},
    { label: "Soundboard", actions: [
      "soundboard_sound_create", "soundboard_sound_update", "soundboard_sound_delete",
    ]},
    { label: "Message Deletes", actions: [
      "message_delete", "message_bulk_delete",
    ]},
    { label: "Message Edits", actions: [
      "message_edit", "message_pin", "message_unpin",
    ]},
    { label: "Server Settings", actions: [
      "guild_update",
      "integration_create", "integration_update", "integration_delete",
      "webhook_create", "webhook_update", "webhook_delete",
      "application_command_permission_update", "bot_add",
      "stage_instance_create", "stage_instance_update", "stage_instance_delete",
      "scheduled_event_create", "scheduled_event_update", "scheduled_event_delete",
      "auto_moderation_rule_create", "auto_moderation_rule_update", "auto_moderation_rule_delete",
      "auto_moderation_block_message", "auto_moderation_flag_to_channel",
      "auto_moderation_user_communication_disabled",
      "onboarding_create", "onboarding_update",
      "onboarding_prompt_create", "onboarding_prompt_update", "onboarding_prompt_delete",
      "onboarding_question_create", "onboarding_question_update",
      "home_settings_create", "home_settings_update",
      "creator_monetization_request_created", "creator_monetization_terms_accepted",
    ]},
    { label: "Emoji / Sticker", actions: [
      "emoji_create", "emoji_update", "emoji_delete",
      "sticker_create", "sticker_update", "sticker_delete",
    ]},
    { label: "Invites", actions: [
      "invite_create", "invite_update", "invite_delete",
    ]},
  ],
  logistics: [
    { label: "Commands",              actions: ["commands"] },
    { label: "Errors",                actions: ["errors"] },
    { label: "Map Queue",             actions: ["map_queue"] },
    { label: "Priority Tracking",     actions: ["priority_tracking"] },
    { label: "Contributor Tracking",  actions: ["contributor_tracking"] },
    { label: "Streaks",               actions: ["streaks"] },
    { label: "AntiNuke",              actions: ["antinuke"] },
    { label: "DM Queue",              actions: ["dm_queue"] },
    { label: "Tippy Activity",        actions: ["tippy_activity"] },
    { label: "Bot Lifecycle",         actions: ["bot_lifecycle"] },
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
  // Tab state — tracks which group is open and (optionally) which
  // specific child action within it is filtered to.
  currentGroupIdx: null,   // index into TABS[currentSection]
  currentChild: null,      // specific action slug filter, or null = show all in group
  // Multi-select: a Set of guild_id strings. Empty Set = "show all guilds".
  // Adding a guild_id narrows the view; clicking the same guild again
  // removes it from the filter. Clicking "All" clears the set entirely.
  guildFilter: new Set(),
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
  // guild-filter listener is no longer a single <select> change — pills
  // wire up their own per-pill click handlers in renderGuildFilter().
  el.refreshBtn().addEventListener("click", () => {
    if (state.currentGroupIdx != null) loadGroup(state.currentGroupIdx, state.currentChild);
  });
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
  state.currentGroupIdx = null;
  state.currentChild = null;
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
  // Auto-open first group, no specific child filter
  if (TABS[sectionSlug].length > 0) loadGroup(0, null);
  startAutoRefresh();
}

// ──────────────────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────────────────
// Two render modes per top-level tab:
//   - actions.length === 1 → plain .tab button (no dropdown)
//   - actions.length  >  1 → .tab-dropdown with a menu of children
//                            (matches wave-leaderboard reviewing page)
function renderTabs(sectionSlug) {
  const bar = el.tabBar();
  bar.innerHTML = "";
  TABS[sectionSlug].forEach((group, idx) => {
    if (group.actions.length === 1) {
      bar.appendChild(makePlainTab(group, idx));
    } else {
      bar.appendChild(makeDropdownTab(group, idx));
    }
  });

  // Click-outside listener closes any open dropdown
  document.addEventListener("click", closeAllDropdownsOnOutsideClick);
}

function makePlainTab(group, idx) {
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.groupIdx = String(idx);
  btn.textContent = group.label;
  btn.addEventListener("click", () => loadGroup(idx, null));
  return btn;
}

function makeDropdownTab(group, idx) {
  const wrapper = document.createElement("div");
  wrapper.className = "tab-dropdown";
  wrapper.dataset.groupIdx = String(idx);

  const btn = document.createElement("button");
  btn.className = "tab-dropdown-btn";
  btn.appendChild(document.createTextNode(group.label + " "));
  const arrow = document.createElement("span");
  arrow.className = "tab-dropdown-arrow";
  arrow.textContent = "▼";
  btn.appendChild(arrow);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // First click also acts as "show all in group"
    if (!wrapper.classList.contains("open")) {
      closeAllDropdowns();
      wrapper.classList.add("open");
    } else {
      wrapper.classList.remove("open");
    }
  });
  wrapper.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "tab-dropdown-menu";

  // "Show all" pseudo-item — selects the whole group
  const allItem = document.createElement("div");
  allItem.className = "tab-dropdown-item tab-dropdown-item-all";
  allItem.textContent = `All ${group.label}`;
  allItem.addEventListener("click", (ev) => {
    ev.stopPropagation();
    wrapper.classList.remove("open");
    loadGroup(idx, null);
  });
  menu.appendChild(allItem);

  // One item per child action
  for (const actionSlug of group.actions) {
    const item = document.createElement("div");
    item.className = "tab-dropdown-item";
    item.dataset.childSlug = actionSlug;
    item.textContent = humanizeSlug(actionSlug);
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      wrapper.classList.remove("open");
      loadGroup(idx, actionSlug);
    });
    menu.appendChild(item);
  }
  wrapper.appendChild(menu);
  return wrapper;
}

function closeAllDropdowns() {
  document.querySelectorAll(".tab-dropdown.open").forEach(d => d.classList.remove("open"));
}

function closeAllDropdownsOnOutsideClick(ev) {
  if (ev.target.closest(".tab-dropdown")) return;
  closeAllDropdowns();
}

function humanizeSlug(slug) {
  // "channel_create" → "Channel Create"; preserves AuditLogAction-ish casing
  return slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function setActiveTab() {
  // Highlight the active top-level group (plain tab OR dropdown button)
  // and the active child item inside any open dropdown menu.
  document.querySelectorAll(".tab, .tab-dropdown-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-dropdown-item").forEach(b => b.classList.remove("active"));
  if (state.currentGroupIdx == null) return;

  const groupNode = document.querySelector(
    `.tab[data-group-idx="${state.currentGroupIdx}"], ` +
    `.tab-dropdown[data-group-idx="${state.currentGroupIdx}"] .tab-dropdown-btn`
  );
  if (groupNode) groupNode.classList.add("active");

  if (state.currentChild) {
    const childNode = document.querySelector(
      `.tab-dropdown[data-group-idx="${state.currentGroupIdx}"] ` +
      `.tab-dropdown-item[data-child-slug="${state.currentChild}"]`
    );
    if (childNode) childNode.classList.add("active");
  } else {
    // No child selected → highlight the "All" item if this group is a dropdown
    const allItem = document.querySelector(
      `.tab-dropdown[data-group-idx="${state.currentGroupIdx}"] .tab-dropdown-item-all`
    );
    if (allItem) allItem.classList.add("active");
  }
}

// ──────────────────────────────────────────────────────────────
// Data loading
// ──────────────────────────────────────────────────────────────
/**
 * Open a tab group. `groupIdx` is the index into TABS[currentSection];
 * `childSlug` (optional) narrows to a single action within the group.
 * Pass null for childSlug to show the merged stream from ALL children.
 */
async function loadGroup(groupIdx, childSlug = null) {
  if (!state.currentSection) return;
  const group = TABS[state.currentSection][groupIdx];
  if (!group) return;

  state.currentGroupIdx = groupIdx;
  state.currentChild = childSlug;
  state.visibleCount = PAGE_SIZE;
  setActiveTab();

  // Decide which action category folders to fetch:
  //   childSlug given → just that one
  //   childSlug null  → all actions in the group (merged stream)
  const actionsToLoad = childSlug ? [childSlug] : group.actions;

  el.loading().classList.remove("hidden");
  el.eventList().innerHTML = "";
  el.emptyState().classList.add("hidden");
  el.loadMoreBtn().classList.add("hidden");

  try {
    // Fetch each action category in parallel and merge results
    const perAction = await Promise.all(
      actionsToLoad.map(a => fetchEventsForCategory(state.currentSection, a))
    );
    const merged = [];
    for (const list of perAction) merged.push(...list);
    merged.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    state.allEvents = merged;
  } catch (err) {
    console.error("[wave-logging] loadGroup error:", err);
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
async function fetchEventsForCategory(section, category) {
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
  // Multi-select: empty Set = show all guilds; non-empty = whitelist filter.
  if (state.guildFilter.size > 0) {
    evs = evs.filter(e => state.guildFilter.has(String(e.guild_id || "")));
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

function toggleGuildFilter(guildId) {
  if (state.guildFilter.has(guildId)) {
    state.guildFilter.delete(guildId);
  } else {
    state.guildFilter.add(guildId);
  }
  state.visibleCount = PAGE_SIZE;
  syncGuildPillsActive();
  renderEvents();
}

function clearGuildFilter() {
  state.guildFilter.clear();
  state.visibleCount = PAGE_SIZE;
  syncGuildPillsActive();
  renderEvents();
}

function syncGuildPillsActive() {
  // Recolor pills to reflect the current state.guildFilter set without
  // re-rendering the whole row (avoids losing focus on rapid clicks).
  document.querySelectorAll(".guild-pill").forEach(p => {
    if (p.dataset.allShortcut === "1") {
      p.classList.toggle("active", state.guildFilter.size === 0);
    } else {
      p.classList.toggle("active", state.guildFilter.has(p.dataset.guildId));
    }
  });
}

function renderGuildFilter() {
  const host = el.guildFilter();
  host.innerHTML = "";

  // "All" shortcut — clears the filter set. Active when set is empty.
  const allBtn = document.createElement("button");
  allBtn.className = "guild-pill";
  allBtn.dataset.allShortcut = "1";
  allBtn.textContent = "All guilds";
  allBtn.addEventListener("click", clearGuildFilter);
  host.appendChild(allBtn);

  for (const g of state.guilds) {
    const pill = document.createElement("button");
    pill.className = "guild-pill";
    pill.dataset.guildId = String(g.id);
    pill.textContent = g.name;
    pill.addEventListener("click", () => toggleGuildFilter(String(g.id)));
    host.appendChild(pill);
  }
  syncGuildPillsActive();
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
    if (state.currentGroupIdx != null) loadGroup(state.currentGroupIdx, state.currentChild);
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}
