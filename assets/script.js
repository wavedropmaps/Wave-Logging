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
// Audit-log card config: action/category → { icon, label, color }
// Colors match Discord's native audit-log palette.
// ──────────────────────────────────────────────────────────────
const AUDIT_EVENT_CONFIG = {
  // bans
  member_banned:          { icon: "🔨", label: "Member Banned",          color: "#ed4245" },
  member_unbanned:        { icon: "✅", label: "Member Unbanned",        color: "#57f287" },
  ban:                    { icon: "🔨", label: "Member Banned",          color: "#ed4245" },
  unban:                  { icon: "✅", label: "Member Unbanned",        color: "#57f287" },
  // kicks / leaves
  member_kicked:          { icon: "🦶", label: "Member Kicked",          color: "#faa81a" },
  member_left:            { icon: "👋", label: "Member Left",            color: "#8e9297" },
  member_leave:           { icon: "👋", label: "Member Left",            color: "#8e9297" },
  // joins
  member_joined:          { icon: "🟢", label: "Member Joined",         color: "#57f287" },
  member_join:            { icon: "🟢", label: "Member Joined",         color: "#57f287" },
  // messages
  message_deleted:        { icon: "🗑️",  label: "Message Deleted",       color: "#ed4245" },
  message_delete:         { icon: "🗑️",  label: "Message Deleted",       color: "#ed4245" },
  message_bulk_deleted:   { icon: "🗑️",  label: "Bulk Delete",           color: "#ed4245" },
  message_bulk_delete:    { icon: "🗑️",  label: "Bulk Delete",           color: "#ed4245" },
  message_edited:         { icon: "✏️",  label: "Message Edited",        color: "#5865f2" },
  raw_message_edited:     { icon: "✏️",  label: "Message Edited",        color: "#5865f2" },
  message_edit:           { icon: "✏️",  label: "Message Edited",        color: "#5865f2" },
  message_pinned:         { icon: "📌",  label: "Message Pinned",        color: "#faa81a" },
  message_unpinned:       { icon: "📌",  label: "Message Unpinned",      color: "#8e9297" },
  // member updates
  member_role_update:     { icon: "🏷️",  label: "Roles Updated",         color: "#5865f2" },
  member_timed_out:       { icon: "⏰",  label: "Member Timed Out",      color: "#faa81a" },
  member_timeout_removed: { icon: "⏰",  label: "Timeout Removed",       color: "#57f287" },
  member_nick_update:     { icon: "✏️",  label: "Nickname Changed",      color: "#5865f2" },
  member_update:          { icon: "✏️",  label: "Member Updated",        color: "#5865f2" },
  // channels / roles
  channel_created:        { icon: "📁",  label: "Channel Created",       color: "#57f287" },
  channel_deleted:        { icon: "📁",  label: "Channel Deleted",       color: "#ed4245" },
  channel_updated:        { icon: "📁",  label: "Channel Updated",       color: "#5865f2" },
  role_created:           { icon: "🏷️",  label: "Role Created",          color: "#57f287" },
  role_deleted:           { icon: "🏷️",  label: "Role Deleted",          color: "#ed4245" },
  role_updated:           { icon: "🏷️",  label: "Role Updated",          color: "#5865f2" },
  // invites
  invite_created:         { icon: "📨",  label: "Invite Created",        color: "#57f287" },
  invite_deleted:         { icon: "📨",  label: "Invite Deleted",        color: "#ed4245" },
  // errors
  slash_command_error:    { icon: "❌",  label: "Command Error",         color: "#ed4245" },
  prefix_command_error:   { icon: "❌",  label: "Command Error",         color: "#ed4245" },
  errors:                 { icon: "❌",  label: "Error",                 color: "#ed4245" },
  // contributor / priority
  role_assigned:          { icon: "✅",  label: "Role Assigned",         color: "#57f287" },
  role_removed:           { icon: "❌",  label: "Role Removed",          color: "#ed4245" },
  role_assigned_backfill: { icon: "⏪",  label: "Role Assigned (backfill)", color: "#faa81a" },
};

function getAuditConfig(event) {
  return AUDIT_EVENT_CONFIG[event.action]
      || AUDIT_EVENT_CONFIG[event.category]
      || { icon: "📋", label: (event.action || event.category || "event").replace(/_/g, " "), color: "#00f0ff" };
}

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
    { label: "Terminal Logs",                     actions: ["terminal_logs"] },
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
    { label: "Nicknames · Timeouts · Profile", actions: [
      "member_update", "user_update",
    ]},
    { label: "Boosts", actions: ["member_boost"] },
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
    { label: "Threads", actions: [
      "thread_create", "thread_delete", "thread_update", "thread_member",
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
    { label: "Messages", actions: [
      "message_delete", "message_bulk_delete",
      "message_edit", "message_pin", "message_unpin",
    ]},
    { label: "Reactions", actions: [
      "reaction_add", "reaction_remove", "reaction_clear",
    ]},
    { label: "AutoMod", actions: [
      "automod_rule_create", "automod_rule_update", "automod_rule_delete",
      "automod_action",
    ]},
    { label: "Webhooks", actions: ["webhook_update"] },
    { label: "Scheduled Events", actions: [
      "scheduled_event_create", "scheduled_event_update",
      "scheduled_event_delete", "scheduled_event_user",
    ]},
    { label: "Stage Instances", actions: [
      "stage_instance_create", "stage_instance_update", "stage_instance_delete",
    ]},
    { label: "Integrations", actions: [
      "integration_create", "integration_update", "integration_delete",
    ]},
    { label: "Server Settings", actions: [
      "guild_update",
      "application_command_permission_update", "bot_add",
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
    { label: "Terminal Logs",         actions: ["terminal_logs"] },
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
  // data-cat drives CSS left-border color
  if (event.category) row.dataset.cat = event.category;
  if (event.action)   row.dataset.action = event.action;

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
    const cfg = getAuditConfig(event);
    const action = document.createElement("span");
    action.className = "event-action";
    // Use human label from config, fall back to humanized action string
    action.textContent = cfg.label !== (event.action || "").replace(/_/g, " ")
      ? cfg.icon + " " + cfg.label
      : humanizeAction(event.action);
    action.style.setProperty("--action-color", cfg.color);
    summary.appendChild(action);
  }

  const text = document.createElement("span");
  text.className = "event-summary-text";
  appendSummaryText(text, event);
  summary.appendChild(text);

  row.appendChild(summary);

  const details = document.createElement("div");
  details.className = "event-row-details";
  buildDetailView(details, event);
  row.appendChild(details);

  // Clicking anywhere in the row toggles expand — EXCEPT clicks inside
  // the details panel itself, so users can click links / sub-toggles /
  // select text in the structured view without collapsing it.
  row.addEventListener("click", (e) => {
    if (e.target.closest('.event-row-details') && row.classList.contains('expanded')) {
      return;
    }
    row.classList.toggle("expanded");
  });

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

  const hint = pickSummaryHint(event);
  if (hint) {
    const dot = document.createElement("span");
    dot.className = "event-hint-sep";
    dot.textContent = " · ";
    container.appendChild(dot);
    const hintEl = document.createElement("span");
    hintEl.className = "event-hint";
    hintEl.textContent = hint;
    container.appendChild(hintEl);
  }
}

function humanizeAction(action) {
  if (!action) return "";
  return action.replace(/_/g, " ");
}

/**
 * Category-aware one-liner. Picks the single most useful piece of
 * context for THIS event type — message content for message events,
 * channel name for channel events, audit reason for bans, etc.
 */
function pickSummaryHint(event) {
  const det = event.details || {};
  const cat = event.category || "";

  // Messages — show channel + truncated content
  if (cat.startsWith("message_") || cat === "message_bulk_delete") {
    const msg = det.message || det.after || det.before;
    if (msg) {
      const ch = msg.channel_name ? `#${msg.channel_name}` : "";
      const txt = msg.content ? `: ${truncate(msg.content, 80)}` : "";
      return `${ch}${txt}`.trim();
    }
    if (det.count != null) return `${det.count} messages`;
  }

  // Reactions
  if (cat.startsWith("reaction_")) {
    const e = det.emoji_name || det.emoji || "?";
    return `${e}`;
  }

  // Bans / kicks — show who did it + reason
  if (cat === "ban" || cat === "unban" || cat === "kick") {
    const parts = [];
    const auditActor = det.audit && det.audit.actor;
    if (auditActor) {
      const who = auditActor.display_name || auditActor.global_name || auditActor.name;
      if (who) parts.push(`by @${who}`);
    }
    if (det.reason) parts.push(`reason: ${truncate(det.reason, 60)}`);
    else if (det.audit && det.audit.reason) parts.push(`reason: ${truncate(det.audit.reason, 60)}`);
    return parts.join(" · ");
  }
  if (cat === "member_leave" && det.audit_kick) {
    const kickActor = det.audit_kick.actor;
    const who = kickActor && (kickActor.display_name || kickActor.global_name || kickActor.name);
    const reason = det.audit_kick.reason;
    const parts = ["kicked"];
    if (who) parts.push(`by @${who}`);
    if (reason) parts.push(`reason: ${truncate(reason, 60)}`);
    return parts.join(" · ");
  }

  // Voice — show channel transition
  if (cat === "voice_state_changed") {
    const b = det.before && det.before.channel && det.before.channel.name;
    const a = det.after && det.after.channel && det.after.channel.name;
    if (a && b && b !== a) return `🔊 ${b} → ${a}`;
    if (a) return `🔊 ${a}`;
    if (b) return `left 🔊 ${b}`;
  }

  // Channels / threads / roles
  if (det.channel && det.channel.name) return `#${det.channel.name}`;
  if (det.thread && det.thread.name) return `🧵 ${det.thread.name}`;
  if (det.role && det.role.name) return `[${det.role.name}]`;

  // Role changes
  if (cat === "member_role_update") {
    const added = (det.added || []).map(r => r.name).filter(Boolean);
    const removed = (det.removed || []).map(r => r.name).filter(Boolean);
    const parts = [];
    if (added.length) parts.push(`+${added.join(", +")}`);
    if (removed.length) parts.push(`-${removed.join(", -")}`);
    return parts.join("  ");
  }

  // Nicknames / timeouts
  if (cat === "member_update") {
    if (det.before !== undefined && det.after !== undefined) {
      return `${det.before || "—"} → ${det.after || "—"}`;
    }
    if (det.until) return `until ${formatTimestamp(det.until)}`;
  }

  // Slash / prefix commands
  if (cat === "commands" || cat === "errors") {
    if (det.command) return `/${det.command}`;
  }

  // Invites
  if (det.invite && det.invite.code) {
    return `${det.invite.code}${det.invite.uses != null ? ` · ${det.invite.uses} uses` : ""}`;
  }

  // Scheduled events / stage
  if (det.event && det.event.name) return det.event.name;
  if (det.stage && det.stage.topic) return det.stage.topic;

  // AutoMod
  if (cat === "automod_action") {
    return `rule ${det.rule_id || "?"}${det.matched_keyword ? ` · "${det.matched_keyword}"` : ""}`;
  }

  // Soundboard
  if (det.sound && det.sound.name) return det.sound.name;

  // Generic fallback — show one preferred key
  const preferred = ["command", "channel_name", "role_name", "reason",
                     "amount", "wallet_type", "error_message",
                     "queue_position", "before", "after"];
  for (const key of preferred) {
    if (det[key] != null && det[key] !== "" && typeof det[key] !== "object") {
      return `${key}: ${truncate(String(det[key]), 80)}`;
    }
  }
  return "";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ──────────────────────────────────────────────────────────────
// Discord-style audit-log card
// Renders a clean, structured card at the top of every expanded
// event — like Discord's own audit log / AutoMod embed format.
// ──────────────────────────────────────────────────────────────

function _auditField(label, value, cls) {
  if (value === null || value === undefined || value === "") return null;
  const row = document.createElement("div");
  row.className = "al-field";
  const lbl = document.createElement("span");
  lbl.className = "al-label";
  lbl.textContent = label;
  const val = document.createElement("span");
  val.className = "al-value" + (cls ? " " + cls : "");
  val.textContent = String(value);
  row.appendChild(lbl);
  row.appendChild(val);
  return row;
}

function _addField(fields, label, value, cls) {
  if (value === null || value === undefined || value === "") return;
  const f = _auditField(label, value, cls);
  if (f) fields.appendChild(f);
}

function _nameOf(u) {
  if (!u) return null;
  const n = u.display_name || u.global_name || u.name;
  return n ? "@" + n : null;
}

function _idOf(u) { return u && u.id ? u.id : null; }

function buildDiscordAuditCard(event) {
  const cfg = getAuditConfig(event);
  const det = event.details || {};
  const actor  = event.actor  || null;
  const target = event.target || null;
  const action = event.action || "";
  const guildName = event.guild_name || null;

  const card = document.createElement("div");
  card.className = "al-card";
  card.style.setProperty("--al-color", cfg.color);

  // Top color bar
  const bar = document.createElement("div");
  bar.className = "al-bar";
  card.appendChild(bar);

  const body = document.createElement("div");
  body.className = "al-body";

  // Title row
  const title = document.createElement("div");
  title.className = "al-title";
  title.textContent = cfg.icon + "  " + cfg.label;
  body.appendChild(title);

  // Key-value fields
  const fields = document.createElement("div");
  fields.className = "al-fields";

  const F = (lbl, val, cls) => _addField(fields, lbl, val, cls);

  // ── BAN / UNBAN ────────────────────────────────────────────
  if (action === "member_banned" || action === "member_unbanned") {
    F("User",     _nameOf(target),  "al-mention");
    F("User ID",  _idOf(target),    "al-mono al-dim");
    const byLabel = action === "member_banned" ? "Banned by" : "Unbanned by";
    const byName  = det.banned_by || det.unbanned_by || _nameOf(actor);
    F(byLabel,    byName || "(unknown)", byName ? "al-mention" : "al-dim");
    const reason = det.reason || (det.audit && det.audit.reason);
    F("Reason",   reason || "(none provided)", reason ? "" : "al-dim");
    const joinedAt = det.joined_at || (target && target.joined_at);
    if (joinedAt) F("Last joined", formatTimestamp(joinedAt));
    if (guildName) F("Guild", guildName);
  }

  // ── KICK / LEAVE ───────────────────────────────────────────
  else if (action === "member_kicked" || action === "member_left") {
    F("User",     _nameOf(target),  "al-mention");
    F("User ID",  _idOf(target),    "al-mono al-dim");
    if (action === "member_kicked") {
      const kickedBy = _nameOf(actor)
                    || (_nameOf(det.audit_kick && det.audit_kick.actor));
      F("Kicked by", kickedBy || "(unknown)", kickedBy ? "al-mention" : "al-dim");
      const kr = det.audit_kick && det.audit_kick.reason;
      F("Reason",    kr || "(none provided)", kr ? "" : "al-dim");
    }
    if (det.tenure_days != null) F("Time in server", det.tenure_days + " days");
    if (det.joined_at) F("Joined", formatTimestamp(det.joined_at));
    if (guildName) F("Guild", guildName);
  }

  // ── MESSAGE DELETED ────────────────────────────────────────
  else if (action === "message_deleted") {
    const msg = det.message || {};
    const au  = msg.author  || {};
    F("User",       _nameOf(actor) || _nameOf(au), "al-mention");
    F("User ID",    _idOf(actor)   || _idOf(au),   "al-mono al-dim");
    F("Message ID", det.message_id || msg.id,      "al-mono al-dim");
    const ch = msg.channel_name || det.channel_name;
    F("Channel",    ch ? "#" + ch : null);
    if (!ch && (det.channel_id || msg.channel_id))
      F("Channel ID", det.channel_id || msg.channel_id, "al-mono al-dim");
    if (msg.created_at) F("Created", formatTimestamp(msg.created_at));
    if (guildName) F("Guild", guildName);
  }

  // ── MESSAGE EDITED (cached) ───────────────────────────────
  else if (action === "message_edited") {
    const msg = det.after || det.before || {};
    const au  = msg.author || {};
    F("User",       _nameOf(actor) || _nameOf(au), "al-mention");
    F("User ID",    _idOf(actor)   || _idOf(au),   "al-mono al-dim");
    const ch = msg.channel_name || det.channel_name;
    F("Channel",    ch ? "#" + ch : null);
    F("Message ID", msg.id || det.message_id, "al-mono al-dim");
    if (msg.created_at) F("Created",  formatTimestamp(msg.created_at));
    if (msg.edited_at)  F("Edited at", formatTimestamp(msg.edited_at));
    if (guildName) F("Guild", guildName);
    const types = (det.change_type || []).join(", ");
    if (types) F("Changed", types);
  }

  // ── RAW MESSAGE EDITED (not cached) ──────────────────────
  else if (action === "raw_message_edited") {
    F("User",       _nameOf(actor),      "al-mention");
    F("User ID",    _idOf(actor),        "al-mono al-dim");
    F("Message ID", det.message_id,      "al-mono al-dim");
    const ch = det.channel_name;
    F("Channel",    ch ? "#" + ch : null);
    if (!ch && det.channel_id) F("Channel ID", det.channel_id, "al-mono al-dim");
    if (det.edited_at) F("Edited at", formatTimestamp(det.edited_at));
    if (guildName) F("Guild", guildName);
    F("Note", "Pre-edit content unavailable — message not in cache", "al-dim");
  }

  // ── MEMBER JOINED ─────────────────────────────────────────
  else if (action === "member_joined") {
    F("User",            _nameOf(target), "al-mention");
    F("User ID",         _idOf(target),   "al-mono al-dim");
    if (target && target.created_at) F("Account created", formatTimestamp(target.created_at));
    if (guildName) F("Guild", guildName);
  }

  // ── ROLE UPDATE ───────────────────────────────────────────
  else if (action === "member_role_update") {
    F("User",       _nameOf(target), "al-mention");
    F("User ID",    _idOf(target),   "al-mono al-dim");
    F("Changed by", _nameOf(actor),  "al-mention");
    const added   = (det.added   || []).map(r => r.name).filter(Boolean).join(", ");
    const removed = (det.removed || []).map(r => r.name).filter(Boolean).join(", ");
    if (added)   F("Roles added",   "+ " + added);
    if (removed) F("Roles removed", "− " + removed);
    if (guildName) F("Guild", guildName);
  }

  // ── CONTRIBUTOR / PRIORITY ROLE ASSIGNED / REMOVED ───────
  else if (action === "role_assigned" || action === "role_assigned_backfill" || action === "role_removed") {
    F("User",       det.username ? "@" + det.username : _nameOf(target), "al-mention");
    F("User ID",    _idOf(target), "al-mono al-dim");
    F("Role",       det.role_type ? det.role_type.charAt(0).toUpperCase() + det.role_type.slice(1) : null);
    if (det.guild_name || guildName) F("Guild", det.guild_name || guildName);
    if (det.assigned_at) F("Assigned",   formatTimestamp(det.assigned_at));
    if (det.expires_at)  F("Expires",    formatTimestamp(det.expires_at));
    if (det.removal_reason) F("Reason", det.removal_reason.replace(/_/g, " "));
    if (det.days_elapsed != null) F("Days elapsed", det.days_elapsed + " days");
  }

  // ── GENERIC FALLBACK ──────────────────────────────────────
  else {
    if (actor)  F("By",     _nameOf(actor),  "al-mention");
    if (target) F("Target", _nameOf(target), "al-mention");
    F("Target ID", _idOf(target), "al-mono al-dim");
    if (guildName) F("Guild", guildName);
    const reason = det.reason || (det.audit && det.audit.reason);
    if (reason) F("Reason", reason);
  }

  body.appendChild(fields);

  // ── Content blocks ────────────────────────────────────────
  function addContentBlock(lbl, text, extraClass) {
    if (!text || !String(text).trim()) return;
    const sec = document.createElement("div");
    sec.className = "al-content-wrap";
    const cl = document.createElement("div");
    cl.className = "al-content-label";
    cl.textContent = lbl;
    sec.appendChild(cl);
    const cb = document.createElement("div");
    cb.className = "al-content" + (extraClass ? " " + extraClass : "");
    cb.textContent = String(text);
    sec.appendChild(cb);
    body.appendChild(sec);
  }

  if (action === "message_deleted") {
    const msg = det.message || {};
    addContentBlock("Content", msg.content);
  }
  if (action === "raw_message_edited") {
    addContentBlock("New content (pre-edit unknown)", det.content);
  }
  if (action === "message_edited" && (det.change_type || []).includes("content")) {
    const b = det.before && det.before.content;
    const a = det.after  && det.after.content;
    addContentBlock("Before", b, "al-content-before");
    addContentBlock("After",  a, "al-content-after");
  }

  card.appendChild(body);
  return card;
}

// ──────────────────────────────────────────────────────────────
// Fat-event detail renderer
// ──────────────────────────────────────────────────────────────

/**
 * Build a structured detail view inside `container` for one event.
 * Cards are appended in display order; a collapsible "Raw JSON"
 * lives at the bottom for power users.
 */
function buildDetailView(container, event) {
  const det = event.details || {};
  const cat = event.category || "";

  // ── Discord-style audit card (always first) ──────────────────
  container.appendChild(buildDiscordAuditCard(event));

  // ── Additional detail sections ───────────────────────────────
  // Actor / target user cards (only for events where the full
  // profile — avatar, roles, timestamps — adds meaningful context)
  const targetNeedsCard = event.target && event.target !== event.actor &&
      (event.target.avatar_url || event.target.roles ||
       event.target.account_created || event.target.created_at);
  // Skip verbose target card for message events — it's just noise
  const isMessageEvent = cat.startsWith("message_");
  if (event.actor && (event.actor.avatar_url || event.actor.roles) && !isMessageEvent) {
    container.appendChild(makeSection("Actor", buildUserCard(event.actor)));
  }
  if (targetNeedsCard && !isMessageEvent) {
    container.appendChild(makeSection("Target", buildUserCard(event.target)));
  }

  // Category-driven cards
  if (det.message) {
    container.appendChild(makeSection("Message", buildMessageCard(det.message)));
  }
  if (det.before && det.after && det.change_type) {
    // Message edit — render side-by-side
    container.appendChild(makeSection(
      `Edit · ${(det.change_type || []).join(", ")}`,
      buildMessageEditCard(det.before, det.after),
    ));
  }
  // raw_message_edit is fully handled by buildDiscordAuditCard above
  if (det.channel) {
    container.appendChild(makeSection("Channel", buildChannelCard(det.channel)));
  }
  if (det.thread) {
    container.appendChild(makeSection("Thread", buildChannelCard(det.thread)));
  }
  if (det.role) {
    container.appendChild(makeSection("Role", buildRoleCard(det.role)));
  }
  if (det.added || det.removed) {
    if (cat === "member_role_update") {
      container.appendChild(makeSection("Roles added", buildRoleList(det.added || [])));
      container.appendChild(makeSection("Roles removed", buildRoleList(det.removed || [])));
    } else if (cat.startsWith("emoji_") || cat.startsWith("sticker_")) {
      if (det.added) container.appendChild(makeSection("Added", buildEmojiList(det.added)));
      if (det.removed) container.appendChild(makeSection("Removed", buildEmojiList(det.removed)));
    }
  }
  if (det.renamed && Array.isArray(det.renamed)) {
    container.appendChild(makeSection("Renamed", buildRenamedList(det.renamed)));
  }
  if (det.guild) {
    container.appendChild(makeSection("Guild", buildGuildCard(det.guild)));
  }
  if (det.invite) {
    container.appendChild(makeSection("Invite", buildInviteCard(det.invite)));
  }
  if (det.sound) {
    container.appendChild(makeSection("Sound", buildKeyValueCard(det.sound)));
  }
  if (det.event && cat.startsWith("scheduled_event")) {
    container.appendChild(makeSection("Scheduled Event", buildKeyValueCard(det.event)));
  }
  if (det.stage) {
    container.appendChild(makeSection("Stage Instance", buildKeyValueCard(det.stage)));
  }
  if (det.rule) {
    container.appendChild(makeSection("AutoMod Rule", buildKeyValueCard(det.rule)));
  }
  if (det.integration) {
    container.appendChild(makeSection("Integration", buildKeyValueCard(det.integration)));
  }

  // Voice — before/after channel
  if (cat === "voice_state_changed" && (det.before || det.after)) {
    container.appendChild(makeSection("Voice", buildVoiceCard(det.before, det.after)));
  }

  // Reactions
  if (cat.startsWith("reaction_")) {
    container.appendChild(makeSection("Reaction", buildReactionContextCard(det)));
  }

  // Generic changes table
  if (det.changes && typeof det.changes === "object" && !Array.isArray(det.changes)) {
    container.appendChild(makeSection("Changes", buildChangesTable(det.changes)));
  }

  // Generic before/after fields (nickname, etc.) when not a message edit
  if (!det.change_type &&
      (det.before !== undefined || det.after !== undefined) &&
      typeof det.before !== "object" && typeof det.after !== "object") {
    container.appendChild(makeSection("Before / After", buildBeforeAfterPair(det.before, det.after)));
  }

  // Command-style detail (slash/prefix args)
  if ((cat === "commands" || cat === "errors") && (det.namespace || det.args || det.kwargs)) {
    container.appendChild(makeSection("Command", buildCommandCard(det)));
  }

  // Error details
  if (cat === "errors" && det.error_message) {
    container.appendChild(makeSection("Error", buildErrorCard(det)));
  }

  // Bulk-delete cached messages
  if (cat === "message_bulk_delete" && Array.isArray(det.cached_messages) && det.cached_messages.length) {
    const wrap = document.createElement("div");
    for (const m of det.cached_messages) wrap.appendChild(buildMessageCard(m));
    container.appendChild(makeSection(`Cached messages (${det.cached_messages.length} of ${det.count || "?"})`, wrap));
  }

  // Audit blocks — always last before raw
  if (det.audit) {
    container.appendChild(makeSection("Audit Log", buildAuditCard(det.audit)));
  }
  if (det.audit_kick) {
    container.appendChild(makeSection("Audit Log (kick)", buildAuditCard(det.audit_kick)));
  }

  // Raw JSON — collapsible
  container.appendChild(buildRawJsonBlock(event));
}

// ── Section wrapper ─────────────────────────────────────────────
function makeSection(label, contentEl) {
  const wrap = document.createElement("section");
  wrap.className = "detail-section";
  const head = document.createElement("div");
  head.className = "detail-section-label";
  head.textContent = label;
  wrap.appendChild(head);
  if (contentEl) wrap.appendChild(contentEl);
  return wrap;
}

function makeKV(label, value, opts) {
  // opts: { code: bool, color: string (CSS) }
  const row = document.createElement("div");
  row.className = "detail-kv";
  const k = document.createElement("span");
  k.className = "detail-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "detail-v" + (opts && opts.code ? " detail-v-code" : "");
  if (opts && opts.color) v.style.color = opts.color;
  if (value === null || value === undefined || value === "") {
    v.textContent = "—";
    v.classList.add("detail-v-empty");
  } else if (typeof value === "object") {
    v.textContent = JSON.stringify(value);
  } else {
    v.textContent = String(value);
  }
  row.appendChild(k);
  row.appendChild(v);
  return row;
}

// ── User card ───────────────────────────────────────────────────
function buildUserCard(user) {
  const card = document.createElement("div");
  card.className = "user-card";

  if (user.avatar_url) {
    const img = document.createElement("img");
    img.className = "user-avatar";
    img.src = user.avatar_url;
    img.loading = "lazy";
    img.alt = "";
    card.appendChild(img);
  }
  const body = document.createElement("div");
  body.className = "user-card-body";

  const name = document.createElement("div");
  name.className = "user-name";
  name.textContent = user.display_name || user.global_name || user.name || user.id || "?";
  body.appendChild(name);

  const sub = document.createElement("div");
  sub.className = "user-sub";
  const subBits = [];
  if (user.name && user.name !== name.textContent) subBits.push("@" + user.name);
  if (user.id) subBits.push("id " + user.id);
  if (user.bot) subBits.push("BOT");
  if (user.system) subBits.push("SYSTEM");
  sub.textContent = subBits.join(" · ");
  body.appendChild(sub);

  if (user.created_at) {
    body.appendChild(makeKV("Account created", formatTimestamp(user.created_at)));
  }
  if (user.joined_at) {
    body.appendChild(makeKV("Joined guild", formatTimestamp(user.joined_at)));
  }
  if (user.premium_since) {
    body.appendChild(makeKV("Boosting since", formatTimestamp(user.premium_since)));
  }
  if (user.timed_out_until) {
    body.appendChild(makeKV("Timed out until", formatTimestamp(user.timed_out_until)));
  }
  if (Array.isArray(user.public_flag_names) && user.public_flag_names.length) {
    body.appendChild(makeKV("Badges", user.public_flag_names.join(", ")));
  }
  if (Array.isArray(user.roles) && user.roles.length) {
    const roleChips = document.createElement("div");
    roleChips.className = "chip-row";
    for (const r of user.roles) {
      const chip = document.createElement("span");
      chip.className = "chip chip-role";
      chip.textContent = r.name;
      if (r.color && r.color !== "#000000") chip.style.borderColor = r.color;
      roleChips.appendChild(chip);
    }
    const wrap = document.createElement("div");
    wrap.className = "detail-kv";
    const k = document.createElement("span");
    k.className = "detail-k";
    k.textContent = "Roles";
    wrap.appendChild(k);
    wrap.appendChild(roleChips);
    body.appendChild(wrap);
  }
  card.appendChild(body);
  return card;
}

// ── Message card ────────────────────────────────────────────────
function buildMessageCard(msg) {
  const card = document.createElement("div");
  card.className = "message-card";

  // Header — author + channel + posted at
  const head = document.createElement("div");
  head.className = "message-card-head";
  if (msg.author) {
    if (msg.author.avatar_url) {
      const img = document.createElement("img");
      img.className = "message-avatar";
      img.src = msg.author.avatar_url;
      img.loading = "lazy";
      img.alt = "";
      head.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "message-author";
    name.textContent = msg.author.display_name || msg.author.global_name ||
                       msg.author.name || msg.author.id || "?";
    head.appendChild(name);
  }
  if (msg.channel_name) {
    const ch = document.createElement("span");
    ch.className = "message-channel";
    ch.textContent = "#" + msg.channel_name;
    head.appendChild(ch);
  }
  if (msg.created_at) {
    const ts = document.createElement("span");
    ts.className = "message-ts";
    ts.textContent = formatTimestamp(msg.created_at);
    head.appendChild(ts);
  }
  if (msg.edited_at) {
    const ed = document.createElement("span");
    ed.className = "message-ts message-ts-edited";
    ed.textContent = "(edited " + formatTimestamp(msg.edited_at) + ")";
    head.appendChild(ed);
  }
  card.appendChild(head);

  // Content
  if (msg.content && msg.content.trim()) {
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = msg.content;
    card.appendChild(content);
  } else {
    const empty = document.createElement("div");
    empty.className = "message-content message-content-empty";
    empty.textContent = "(no text content)";
    card.appendChild(empty);
  }

  // Attachments
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    card.appendChild(buildAttachmentList(msg.attachments));
  }
  // Embeds
  if (Array.isArray(msg.embeds) && msg.embeds.length) {
    const wrap = document.createElement("div");
    wrap.className = "embed-list";
    for (const e of msg.embeds) wrap.appendChild(buildEmbedCard(e));
    card.appendChild(wrap);
  }
  // Stickers
  if (Array.isArray(msg.stickers) && msg.stickers.length) {
    const row = document.createElement("div");
    row.className = "chip-row";
    for (const s of msg.stickers) {
      const chip = document.createElement("span");
      chip.className = "chip chip-sticker";
      chip.textContent = "🩹 " + (s.name || s.id);
      row.appendChild(chip);
    }
    card.appendChild(row);
  }
  // Mentions
  if (msg.mentions) {
    const m = msg.mentions;
    const totalMentions = (m.users || []).length + (m.roles || []).length +
                          (m.channels || []).length + (m.everyone ? 1 : 0);
    if (totalMentions > 0) {
      const row = document.createElement("div");
      row.className = "chip-row chip-row-labeled";
      const lbl = document.createElement("span");
      lbl.className = "chip-row-label";
      lbl.textContent = "Mentions";
      row.appendChild(lbl);
      for (const u of (m.users || [])) {
        const chip = document.createElement("span");
        chip.className = "chip chip-mention chip-user";
        chip.textContent = "@" + u.name;
        row.appendChild(chip);
      }
      for (const r of (m.roles || [])) {
        const chip = document.createElement("span");
        chip.className = "chip chip-mention chip-role";
        chip.textContent = "@" + (r.name || r.id);
        row.appendChild(chip);
      }
      for (const c of (m.channels || [])) {
        const chip = document.createElement("span");
        chip.className = "chip chip-mention chip-channel";
        chip.textContent = "#" + (c.name || c.id);
        row.appendChild(chip);
      }
      if (m.everyone) {
        const chip = document.createElement("span");
        chip.className = "chip chip-mention chip-everyone";
        chip.textContent = "@everyone";
        row.appendChild(chip);
      }
      card.appendChild(row);
    }
  }
  // Reactions
  if (Array.isArray(msg.reactions) && msg.reactions.length) {
    const row = document.createElement("div");
    row.className = "chip-row chip-row-labeled";
    const lbl = document.createElement("span");
    lbl.className = "chip-row-label";
    lbl.textContent = "Reactions";
    row.appendChild(lbl);
    for (const r of msg.reactions) {
      const chip = document.createElement("span");
      chip.className = "chip chip-reaction";
      chip.textContent = `${r.emoji} ${r.count}`;
      row.appendChild(chip);
    }
    card.appendChild(row);
  }
  // Reply reference
  if (msg.reference && msg.reference.message_id) {
    const ref = document.createElement("div");
    ref.className = "message-reference";
    ref.textContent = `↩ Reply to message ${msg.reference.message_id}`;
    card.appendChild(ref);
  }
  // Jump link
  if (msg.jump_url) {
    const a = document.createElement("a");
    a.className = "message-jump";
    a.href = msg.jump_url;
    a.textContent = "Jump to message →";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    card.appendChild(a);
  }
  // Footer — flags / type / pinned / tts
  const footer = document.createElement("div");
  footer.className = "message-footer";
  const flags = [];
  if (msg.pinned) flags.push("📌 pinned");
  if (msg.tts) flags.push("🔊 tts");
  if (msg.type && msg.type !== "default" && msg.type !== "MessageType.default") flags.push(String(msg.type));
  if (msg.id) flags.push("id " + msg.id);
  footer.textContent = flags.join(" · ");
  if (flags.length) card.appendChild(footer);

  return card;
}

function buildMessageEditCard(before, after) {
  const wrap = document.createElement("div");
  wrap.className = "edit-pair";
  const beforeWrap = document.createElement("div");
  beforeWrap.className = "edit-side edit-before";
  const beforeLbl = document.createElement("div");
  beforeLbl.className = "edit-side-label";
  beforeLbl.textContent = "Before";
  beforeWrap.appendChild(beforeLbl);
  beforeWrap.appendChild(buildMessageCard(before));
  const afterWrap = document.createElement("div");
  afterWrap.className = "edit-side edit-after";
  const afterLbl = document.createElement("div");
  afterLbl.className = "edit-side-label";
  afterLbl.textContent = "After";
  afterWrap.appendChild(afterLbl);
  afterWrap.appendChild(buildMessageCard(after));
  wrap.appendChild(beforeWrap);
  wrap.appendChild(afterWrap);
  return wrap;
}

// ── Raw edit card (message not in cache) ────────────────────────
function buildRawEditCard(det) {
  const card = document.createElement("div");
  card.className = "message-card";

  if (det.channel_name || det.channel_id) {
    card.appendChild(makeKV("Channel", det.channel_name ? "#" + det.channel_name : det.channel_id));
  }
  if (det.message_id) card.appendChild(makeKV("Message ID", det.message_id, {code: true}));
  if (det.edited_at) card.appendChild(makeKV("Edited at", formatTimestamp(det.edited_at)));

  const beforeNote = document.createElement("div");
  beforeNote.className = "message-content message-content-empty";
  beforeNote.textContent = "⚠ Pre-edit content unavailable (message not in cache)";
  card.appendChild(beforeNote);

  if (det.content && det.content.trim()) {
    const afterLbl = document.createElement("div");
    afterLbl.className = "edit-side-label";
    afterLbl.textContent = "New content";
    card.appendChild(afterLbl);
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = det.content;
    card.appendChild(content);
  }
  return card;
}

// ── Attachments ─────────────────────────────────────────────────
function buildAttachmentList(attachments) {
  const wrap = document.createElement("div");
  wrap.className = "attachment-list";
  for (const a of attachments) {
    const item = document.createElement("div");
    item.className = "attachment";
    if (a.content_type && String(a.content_type).startsWith("image/") && a.url) {
      const img = document.createElement("img");
      img.className = "attachment-image";
      img.src = a.url;
      img.loading = "lazy";
      img.alt = a.filename || "";
      if (a.is_spoiler) img.classList.add("attachment-spoiler");
      item.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.textContent = "📎";
      item.appendChild(icon);
    }
    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    if (a.url) {
      const link = document.createElement("a");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = a.filename || "(no filename)";
      meta.appendChild(link);
    } else {
      meta.appendChild(document.createTextNode(a.filename || "(no filename)"));
    }
    const sub = document.createElement("div");
    sub.className = "attachment-sub";
    const bits = [];
    if (a.size != null) bits.push(humanBytes(a.size));
    if (a.content_type) bits.push(a.content_type);
    if (a.width && a.height) bits.push(`${a.width}×${a.height}`);
    if (a.is_spoiler) bits.push("SPOILER");
    sub.textContent = bits.join(" · ");
    meta.appendChild(sub);
    item.appendChild(meta);
    wrap.appendChild(item);
  }
  return wrap;
}

function humanBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ── Embed card ──────────────────────────────────────────────────
function buildEmbedCard(embed) {
  const card = document.createElement("div");
  card.className = "embed-card";
  if (embed.color) {
    // discord embeds store color as a decimal int
    const hex = "#" + Number(embed.color).toString(16).padStart(6, "0");
    card.style.borderLeftColor = hex;
  }
  if (embed.author && embed.author.name) {
    const a = document.createElement("div");
    a.className = "embed-author";
    a.textContent = embed.author.name;
    card.appendChild(a);
  }
  if (embed.title) {
    const t = document.createElement("div");
    t.className = "embed-title";
    if (embed.url) {
      const link = document.createElement("a");
      link.href = embed.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = embed.title;
      t.appendChild(link);
    } else {
      t.textContent = embed.title;
    }
    card.appendChild(t);
  }
  if (embed.description) {
    const d = document.createElement("div");
    d.className = "embed-description";
    d.textContent = embed.description;
    card.appendChild(d);
  }
  if (Array.isArray(embed.fields) && embed.fields.length) {
    const fl = document.createElement("div");
    fl.className = "embed-fields";
    for (const f of embed.fields) {
      const fwrap = document.createElement("div");
      fwrap.className = "embed-field";
      if (f.inline) fwrap.classList.add("embed-field-inline");
      const fn = document.createElement("div");
      fn.className = "embed-field-name";
      fn.textContent = f.name || "";
      const fv = document.createElement("div");
      fv.className = "embed-field-value";
      fv.textContent = f.value || "";
      fwrap.appendChild(fn);
      fwrap.appendChild(fv);
      fl.appendChild(fwrap);
    }
    card.appendChild(fl);
  }
  if (embed.image && embed.image.url) {
    const img = document.createElement("img");
    img.className = "embed-image";
    img.src = embed.image.url;
    img.loading = "lazy";
    img.alt = "";
    card.appendChild(img);
  }
  if (embed.thumbnail && embed.thumbnail.url) {
    const img = document.createElement("img");
    img.className = "embed-thumbnail";
    img.src = embed.thumbnail.url;
    img.loading = "lazy";
    img.alt = "";
    card.appendChild(img);
  }
  if (embed.footer && embed.footer.text) {
    const f = document.createElement("div");
    f.className = "embed-footer";
    f.textContent = embed.footer.text;
    card.appendChild(f);
  }
  return card;
}

// ── Channel card ────────────────────────────────────────────────
function buildChannelCard(ch) {
  const card = document.createElement("div");
  card.className = "info-card";
  const head = document.createElement("div");
  head.className = "info-card-head";
  head.textContent = (ch.type && String(ch.type).includes("voice") ? "🔊 " : "#") +
                     (ch.name || ch.id || "?");
  card.appendChild(head);
  card.appendChild(makeKV("ID", ch.id));
  if (ch.type) card.appendChild(makeKV("Type", ch.type));
  if (ch.position != null) card.appendChild(makeKV("Position", ch.position));
  if (ch.topic) card.appendChild(makeKV("Topic", ch.topic));
  if (ch.nsfw != null) card.appendChild(makeKV("NSFW", ch.nsfw ? "yes" : "no"));
  if (ch.slowmode_delay) card.appendChild(makeKV("Slowmode", ch.slowmode_delay + "s"));
  if (ch.category && ch.category.name) card.appendChild(makeKV("Category", ch.category.name));
  if (ch.bitrate) card.appendChild(makeKV("Bitrate", ch.bitrate));
  if (ch.user_limit != null) card.appendChild(makeKV("User limit", ch.user_limit));
  if (ch.rtc_region) card.appendChild(makeKV("Region", ch.rtc_region));
  if (ch.archived != null) card.appendChild(makeKV("Archived", ch.archived ? "yes" : "no"));
  if (ch.locked != null) card.appendChild(makeKV("Locked", ch.locked ? "yes" : "no"));
  if (ch.auto_archive_duration) card.appendChild(makeKV("Auto-archive", ch.auto_archive_duration + " min"));
  if (Array.isArray(ch.overwrites) && ch.overwrites.length) {
    card.appendChild(buildOverwritesTable(ch.overwrites));
  }
  return card;
}

function buildOverwritesTable(overwrites) {
  const wrap = document.createElement("div");
  wrap.className = "overwrites";
  const lbl = document.createElement("div");
  lbl.className = "overwrites-label";
  lbl.textContent = "Permission overwrites";
  wrap.appendChild(lbl);
  for (const o of overwrites) {
    const row = document.createElement("div");
    row.className = "overwrite-row";
    const who = document.createElement("span");
    who.className = "overwrite-who";
    who.textContent = `${o.target_type || "?"}: ${o.target_name || o.target_id}`;
    row.appendChild(who);
    if (o.allow) {
      const a = document.createElement("span");
      a.className = "overwrite-allow";
      a.textContent = "+" + o.allow;
      row.appendChild(a);
    }
    if (o.deny) {
      const d = document.createElement("span");
      d.className = "overwrite-deny";
      d.textContent = "−" + o.deny;
      row.appendChild(d);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

// ── Role card ───────────────────────────────────────────────────
function buildRoleCard(role) {
  const card = document.createElement("div");
  card.className = "info-card";
  const head = document.createElement("div");
  head.className = "info-card-head";
  const swatch = document.createElement("span");
  swatch.className = "color-swatch";
  if (role.color) swatch.style.background = role.color;
  head.appendChild(swatch);
  const nm = document.createElement("span");
  nm.textContent = role.name || role.id || "?";
  head.appendChild(nm);
  card.appendChild(head);
  card.appendChild(makeKV("ID", role.id));
  if (role.position != null) card.appendChild(makeKV("Position", role.position));
  if (role.hoist != null) card.appendChild(makeKV("Hoisted", role.hoist ? "yes" : "no"));
  if (role.mentionable != null) card.appendChild(makeKV("Mentionable", role.mentionable ? "yes" : "no"));
  if (role.managed) card.appendChild(makeKV("Managed", "yes (bot/integration)"));
  if (role.icon_url) {
    const wrap = document.createElement("div");
    wrap.className = "detail-kv";
    const k = document.createElement("span");
    k.className = "detail-k";
    k.textContent = "Icon";
    const img = document.createElement("img");
    img.className = "role-icon";
    img.src = role.icon_url;
    img.loading = "lazy";
    img.alt = "";
    wrap.appendChild(k);
    wrap.appendChild(img);
    card.appendChild(wrap);
  }
  if (role.unicode_emoji) card.appendChild(makeKV("Emoji", role.unicode_emoji));
  if (Array.isArray(role.permission_names) && role.permission_names.length) {
    const row = document.createElement("div");
    row.className = "chip-row chip-row-labeled";
    const lbl = document.createElement("span");
    lbl.className = "chip-row-label";
    lbl.textContent = `Permissions (${role.permission_names.length})`;
    row.appendChild(lbl);
    for (const p of role.permission_names) {
      const chip = document.createElement("span");
      chip.className = "chip chip-perm";
      chip.textContent = p;
      row.appendChild(chip);
    }
    card.appendChild(row);
  } else if (role.permissions != null) {
    card.appendChild(makeKV("Permissions bitmask", role.permissions));
  }
  return card;
}

function buildRoleList(roles) {
  if (!roles || !roles.length) {
    const empty = document.createElement("div");
    empty.className = "detail-empty";
    empty.textContent = "(none)";
    return empty;
  }
  const wrap = document.createElement("div");
  for (const r of roles) {
    wrap.appendChild(buildRoleCard(r));
  }
  return wrap;
}

// ── Guild / invite / generic key-value ──────────────────────────
function buildGuildCard(g) {
  return buildKeyValueCard(g, {
    icon: g.icon_url, banner: g.banner_url,
  });
}

function buildInviteCard(inv) {
  const card = document.createElement("div");
  card.className = "info-card";
  const head = document.createElement("div");
  head.className = "info-card-head";
  head.textContent = inv.url || inv.code || "?";
  card.appendChild(head);
  if (inv.uses != null) card.appendChild(makeKV("Uses", inv.uses));
  if (inv.max_uses != null) card.appendChild(makeKV("Max uses", inv.max_uses || "∞"));
  if (inv.max_age != null) card.appendChild(makeKV("Max age", inv.max_age ? inv.max_age + "s" : "∞"));
  if (inv.temporary != null) card.appendChild(makeKV("Temporary", inv.temporary ? "yes" : "no"));
  if (inv.channel) card.appendChild(makeKV("Channel", "#" + (inv.channel.name || inv.channel.id)));
  if (inv.inviter) card.appendChild(makeKV("Inviter", inv.inviter.name));
  if (inv.created_at) card.appendChild(makeKV("Created", formatTimestamp(inv.created_at)));
  if (inv.expires_at) card.appendChild(makeKV("Expires", formatTimestamp(inv.expires_at)));
  return card;
}

function buildKeyValueCard(obj, opts) {
  const card = document.createElement("div");
  card.className = "info-card";
  if (opts && opts.icon) {
    const img = document.createElement("img");
    img.src = opts.icon;
    img.className = "info-icon";
    img.loading = "lazy";
    img.alt = "";
    card.appendChild(img);
  }
  if (obj && obj.name) {
    const head = document.createElement("div");
    head.className = "info-card-head";
    head.textContent = obj.name;
    card.appendChild(head);
  }
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === "name") continue;
    if (v == null || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      // Render nested objects inline (one-level deep)
      const inner = document.createElement("div");
      inner.className = "detail-kv-nested";
      for (const [nk, nv] of Object.entries(v)) {
        if (nv == null || nv === "") continue;
        inner.appendChild(makeKV(nk, nv));
      }
      if (inner.children.length) {
        const wrap = document.createElement("div");
        wrap.className = "detail-kv";
        const ko = document.createElement("span");
        ko.className = "detail-k";
        ko.textContent = k;
        wrap.appendChild(ko);
        wrap.appendChild(inner);
        card.appendChild(wrap);
      }
      continue;
    }
    if (Array.isArray(v)) {
      card.appendChild(makeKV(k, v.length ? `${v.length} items` : "(empty)"));
      continue;
    }
    card.appendChild(makeKV(k, v, { code: typeof v === "number" }));
  }
  return card;
}

// ── Emoji / sticker list ────────────────────────────────────────
function buildEmojiList(emojis) {
  const wrap = document.createElement("div");
  wrap.className = "emoji-grid";
  for (const e of emojis) {
    const item = document.createElement("div");
    item.className = "emoji-item";
    if (e.url) {
      const img = document.createElement("img");
      img.src = e.url;
      img.loading = "lazy";
      img.alt = e.name || "";
      item.appendChild(img);
    } else {
      const span = document.createElement("span");
      span.className = "emoji-placeholder";
      span.textContent = "🩹";
      item.appendChild(span);
    }
    const lbl = document.createElement("div");
    lbl.className = "emoji-label";
    lbl.textContent = ":" + (e.name || e.id) + ":";
    item.appendChild(lbl);
    wrap.appendChild(item);
  }
  return wrap;
}

function buildRenamedList(items) {
  const wrap = document.createElement("div");
  wrap.className = "renamed-list";
  for (const r of items) {
    const row = document.createElement("div");
    row.className = "renamed-row";
    if (r.before && r.before.url) {
      const img = document.createElement("img");
      img.src = r.before.url;
      img.className = "emoji-mini";
      img.loading = "lazy";
      row.appendChild(img);
    }
    const txt = document.createElement("span");
    const beforeName = (r.before && r.before.name) || "";
    const afterName = (r.after && r.after.name) || "";
    txt.textContent = `:${beforeName}: → :${afterName}:`;
    row.appendChild(txt);
    wrap.appendChild(row);
  }
  return wrap;
}

// ── Voice card ──────────────────────────────────────────────────
function buildVoiceCard(before, after) {
  const card = document.createElement("div");
  card.className = "info-card";
  const arrow = document.createElement("div");
  arrow.className = "voice-arrow";
  const b = before && before.channel && before.channel.name ? `🔊 ${before.channel.name}` : "—";
  const a = after && after.channel && after.channel.name ? `🔊 ${after.channel.name}` : "—";
  arrow.textContent = `${b}    →    ${a}`;
  card.appendChild(arrow);

  const flags = [];
  const flagKeys = ["self_mute", "self_deaf", "self_stream", "self_video",
                    "mute", "deaf", "suppress", "afk"];
  for (const k of flagKeys) {
    const bv = before && before[k];
    const av = after && after[k];
    if (bv !== av) {
      flags.push(`${k}: ${bv ? "✓" : "✗"} → ${av ? "✓" : "✗"}`);
    } else if (av) {
      flags.push(`${k}: ✓`);
    }
  }
  if (flags.length) {
    const row = document.createElement("div");
    row.className = "voice-flags";
    row.textContent = flags.join("  ·  ");
    card.appendChild(row);
  }
  return card;
}

// ── Reaction context card ───────────────────────────────────────
function buildReactionContextCard(det) {
  const card = document.createElement("div");
  card.className = "info-card";
  const head = document.createElement("div");
  head.className = "reaction-head";
  head.textContent = det.emoji_name || det.emoji || "?";
  card.appendChild(head);
  if (det.message_id) card.appendChild(makeKV("Message", det.message_id));
  if (det.channel_id) card.appendChild(makeKV("Channel", det.channel_id));
  if (det.user_id) card.appendChild(makeKV("User", det.user_id));
  if (det.burst != null) card.appendChild(makeKV("Burst (super reaction)", det.burst ? "yes" : "no"));
  if (det.emoji_animated) card.appendChild(makeKV("Animated", "yes"));
  return card;
}

// ── Changes table ───────────────────────────────────────────────
function buildChangesTable(changes) {
  const tbl = document.createElement("div");
  tbl.className = "changes-table";
  for (const [field, val] of Object.entries(changes)) {
    if (val && typeof val === "object" && "before" in val && "after" in val) {
      tbl.appendChild(makeChangeRow(field, val.before, val.after));
    } else if (Array.isArray(val)) {
      tbl.appendChild(makeKV(field, val.length ? val.join(", ") : "(none)"));
    } else if (val && typeof val === "object") {
      // Nested {added, removed}
      const sub = document.createElement("div");
      sub.className = "detail-kv-nested";
      for (const [sk, sv] of Object.entries(val)) {
        if (Array.isArray(sv)) {
          sub.appendChild(makeKV(sk, sv.length ? sv.join(", ") : "(none)"));
        } else {
          sub.appendChild(makeKV(sk, sv));
        }
      }
      const wrap = document.createElement("div");
      wrap.className = "detail-kv";
      const k = document.createElement("span");
      k.className = "detail-k";
      k.textContent = field;
      wrap.appendChild(k);
      wrap.appendChild(sub);
      tbl.appendChild(wrap);
    } else {
      tbl.appendChild(makeKV(field, val));
    }
  }
  return tbl;
}

function makeChangeRow(field, before, after) {
  const row = document.createElement("div");
  row.className = "change-row";
  const fname = document.createElement("div");
  fname.className = "change-field";
  fname.textContent = field;
  row.appendChild(fname);
  const pair = document.createElement("div");
  pair.className = "change-pair";
  const b = document.createElement("span");
  b.className = "change-before";
  b.textContent = before == null || before === "" ? "—" : String(before);
  pair.appendChild(b);
  const sep = document.createElement("span");
  sep.className = "change-sep";
  sep.textContent = "→";
  pair.appendChild(sep);
  const a = document.createElement("span");
  a.className = "change-after";
  a.textContent = after == null || after === "" ? "—" : String(after);
  pair.appendChild(a);
  row.appendChild(pair);
  return row;
}

function buildBeforeAfterPair(before, after) {
  const card = document.createElement("div");
  card.className = "info-card";
  card.appendChild(makeChangeRow("", before, after));
  return card;
}

// ── Command / error cards ───────────────────────────────────────
function buildCommandCard(det) {
  const card = document.createElement("div");
  card.className = "info-card";
  if (det.command) {
    const head = document.createElement("div");
    head.className = "info-card-head";
    head.textContent = "/" + det.command;
    card.appendChild(head);
  }
  if (det.invoked_with) card.appendChild(makeKV("Invoked with", det.invoked_with));
  if (det.namespace && typeof det.namespace === "object") {
    for (const [k, v] of Object.entries(det.namespace)) {
      card.appendChild(makeKV(k, v, { code: true }));
    }
  }
  if (Array.isArray(det.args) && det.args.length) {
    card.appendChild(makeKV("args", det.args.join(", "), { code: true }));
  }
  if (det.kwargs && typeof det.kwargs === "object" && Object.keys(det.kwargs).length) {
    for (const [k, v] of Object.entries(det.kwargs)) {
      card.appendChild(makeKV("kw " + k, v, { code: true }));
    }
  }
  if (det.interaction_locale) card.appendChild(makeKV("Locale", det.interaction_locale));
  if (det.channel_name) card.appendChild(makeKV("Channel", "#" + det.channel_name));
  if (det.interaction_id) card.appendChild(makeKV("Interaction id", det.interaction_id));
  return card;
}

function buildErrorCard(det) {
  const card = document.createElement("div");
  card.className = "error-card";
  if (det.error_type) {
    const head = document.createElement("div");
    head.className = "error-head";
    head.textContent = det.error_type;
    card.appendChild(head);
  }
  if (det.error_message) {
    const msg = document.createElement("div");
    msg.className = "error-message";
    msg.textContent = det.error_message;
    card.appendChild(msg);
  }
  if (det.traceback) {
    const tb = document.createElement("pre");
    tb.className = "error-traceback";
    tb.textContent = det.traceback;
    card.appendChild(tb);
  }
  return card;
}

// ── Audit card ──────────────────────────────────────────────────
function buildAuditCard(audit) {
  const card = document.createElement("div");
  card.className = "audit-card";
  if (audit.actor) {
    const lbl = document.createElement("div");
    lbl.className = "detail-k";
    lbl.textContent = "Moderator";
    card.appendChild(lbl);
    card.appendChild(buildUserCard(audit.actor));
  }
  if (audit.reason) {
    const r = document.createElement("div");
    r.className = "audit-reason";
    const rl = document.createElement("span");
    rl.className = "detail-k";
    rl.textContent = "Reason";
    const rv = document.createElement("span");
    rv.className = "audit-reason-text";
    rv.textContent = audit.reason;
    r.appendChild(rl);
    r.appendChild(rv);
    card.appendChild(r);
  }
  if (audit.created_at) {
    card.appendChild(makeKV("Recorded at", formatTimestamp(audit.created_at)));
  }
  if (Array.isArray(audit.changes) && audit.changes.length) {
    const lbl2 = document.createElement("div");
    lbl2.className = "detail-k";
    lbl2.textContent = "Discord's diff";
    card.appendChild(lbl2);
    const tbl = document.createElement("div");
    tbl.className = "changes-table";
    for (const c of audit.changes) {
      tbl.appendChild(makeChangeRow(c.key, c.before, c.after));
    }
    card.appendChild(tbl);
  }
  if (audit.extra && typeof audit.extra === "object") {
    const lbl3 = document.createElement("div");
    lbl3.className = "detail-k";
    lbl3.textContent = "Extra metadata";
    card.appendChild(lbl3);
    for (const [k, v] of Object.entries(audit.extra)) {
      card.appendChild(makeKV(k, v));
    }
  }
  if (audit.audit_id) {
    card.appendChild(makeKV("Audit id", audit.audit_id));
  }
  return card;
}

// ── Raw JSON collapsible ────────────────────────────────────────
function buildRawJsonBlock(event) {
  const wrap = document.createElement("details");
  wrap.className = "raw-json";
  const sum = document.createElement("summary");
  sum.textContent = "Raw JSON";
  wrap.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "raw-json-body";
  pre.textContent = JSON.stringify(event, null, 2);
  wrap.appendChild(pre);
  return wrap;
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
