"use strict";
/* Receipts founder dashboard. Plain JS, no build step, no CDN.
   All agent- and web-sourced text is inserted with textContent (via h()), never as HTML. */

const S = { runId: null, snap: null, status: null, filter: { hyp: null, view: "all", showTest: false },
  tab: "trace", nowKey: null, draft: null, dirty: false, poll: null, seen: { trace: 0, decisions: 0 },
  sig: {}, expanded: new Set(), kidKey: null, kidOpen: null, kidText: {},
  view: (() => { try { return localStorage.getItem("rc_view") || "simple"; } catch (_) { return "simple"; } })() };

const TIER_LABEL = { llm_opinion: "LLM opinion", desk_research: "Desk research", observed_pain: "Observed pain", stated_intent: "Stated intent", commitment: "Commitment" };
const TIER_W = { llm_opinion: 0, stated_intent: 1, desk_research: 2, observed_pain: 3, commitment: 4 };
const METRIC_LABEL = { supporting_entries: "supporting entries", refuting_entries: "refuting entries", support_share: "support share", reserve_rate: "reserve rate", reserve_rate_at_price: "reserve rate at ≥ price" };
const SHARE = new Set(["support_share", "reserve_rate", "reserve_rate_at_price"]);
const VERDICT_LABEL = { go: "Go", kill: "Kill", pivot: "Pivot", insufficient_evidence: "Insufficient evidence" };

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (s, el = document) => el.querySelector(s);
const add = (el, ...kids) => { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k); return el; };
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const fill = (el, ...kids) => { clear(el); for (const k of kids.flat(Infinity)) if (k) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k))); return el; };
const time = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); };
const fmtThreshold = (hy) => `${hy.comparator} ${SHARE.has(hy.metric) ? (Number(hy.threshold) * 100).toFixed(1).replace(/\.0$/, "") + "%" : Number(hy.threshold)}`;

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 7000 : 3000);
}

async function api(method, path, body) {
  // Every dashboard call carries the founder header; the server refuses founder actions without it.
  const headers = { "X-Receipts-Founder": "1" };
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (_) { /* empty */ }
  if (!r.ok) throw new Error((data && data.detail) || `Request failed (${r.status})`);
  return data;
}
// Errors from a POST are shown inline, in the card the founder last clicked in, as well as in a toast.
document.addEventListener("click", (e) => { S.lastClick = e.target; }, true);
function inlineErr(msg) {
  const host = S.lastClick && S.lastClick.closest ? S.lastClick.closest("[data-errhost]") : null;
  const box = host ? host.querySelector(".inline-err") : null;
  if (box) { box.textContent = msg; box.hidden = false; } else toast(msg, true);
}
function clearInlineErr() {
  const host = S.lastClick && S.lastClick.closest ? S.lastClick.closest("[data-errhost]") : null;
  const box = host ? host.querySelector(".inline-err") : null;
  if (box) box.hidden = true;
}
// The button that started an action shows a spinner and cannot be pressed again until the server answers.
function busyButton() {
  const b = S.lastClick && S.lastClick.closest ? S.lastClick.closest("button") : null;
  if (!b || !b.isConnected || b.classList.contains("is-busy")) return null;
  const was = b.disabled;
  b.disabled = true; b.classList.add("is-busy"); b.setAttribute("aria-busy", "true");
  return () => { b.disabled = was; b.classList.remove("is-busy"); b.removeAttribute("aria-busy"); };
}
async function act(method, path, body, okMsg) {
  const done = busyButton();
  try {
    const snap = await api(method, path, body);
    clearInlineErr();
    if (snap && snap.run) setSnap(snap, true); else refresh();
    if (okMsg) toast(okMsg);
    return snap === null || snap === undefined ? {} : snap;
  } catch (e) { inlineErr(e.message); toast(e.message, true); return null; }
  finally { if (done) done(); }
}
const runPath = (p) => `/api/runs/${S.runId}${p}`;

// ------------------------------------------------------------------ routing
async function route() {
  document.querySelectorAll(".modal").forEach((m) => m.remove());
  // A different page or run starts at the top; the live poll never calls route(), so reading is not interrupted.
  if (location.hash !== S.routeKey) { S.routeKey = location.hash; window.scrollTo(0, 0); }
  const m = location.hash.match(/run\/(\d+)/);
  clearTimeout(S.poll);
  // Something shows at once: a run being opened gets a skeleton until its first snapshot arrives.
  if (m && (Number(m[1]) !== S.runId || !S.snap)) { clear($("#banner")); fill($("#app"), runSkeleton()); }
  else if (!m && !$("#app").firstChild) fill($("#app"), h("div", { class: "kid skel" }, h("div", { class: "running skel-label", role: "status" }, h("span", { class: "spin" }), "Loading…")));
  S.status = await api("GET", "/api/status").catch(() => null);
  if (m) {
    const id = Number(m[1]);
    if (id !== S.runId) { S.runId = id; S.snap = null; S.nowKey = null; S.sig = {}; S.seen = { trace: 0, decisions: 0 }; S.filter = { hyp: null, view: "all", showTest: false }; S.draft = null; S.dirty = false; S.kidKey = null; S.kidOpen = null; S.kidText = {}; S.openDocs = new Set(); S.briefDraft = null; S.notes = null; S.useSharp = null; S.kidTab = "now"; S.xTab = null; S.docPhase = null; S.docPicked = false; S.docSel = {}; S.actView = "trace"; }
    await refresh();
  } else {
    S.runId = null; S.snap = null;
    if (/^#\/recorded/.test(location.hash)) return renderRecorded();
    renderBriefHome();
  }
}
async function refresh() {
  const id = S.runId;
  if (!id) return;
  try {
    const snap = await api("GET", `/api/runs/${id}`);
    if (S.runId === id) setSnap(snap);
  } catch (e) {
    // The backend may be restarting: say so once, keep polling.
    if (S.runId === id) {
      if (!S.snap) fill($("#app"), h("div", { class: "kid" }, h("div", { class: "kid-card" }, h("div", { class: "running" }, h("span", { class: "spin" }), h("h2", null, "Waiting for the server")), h("p", { class: "kid-hint" }, e.message, ". Trying again every few seconds."))));
      else fill($("#banner"), h("div", { class: "banner warn", role: "status" }, h("span", { class: "spin" }), h("span", null, "Lost contact with the server. Trying again… What you see may be out of date.")));
      clearTimeout(S.poll); S.poll = setTimeout(refresh, 3000);
    }
  }
}
function setSnap(snap, immediate = false) {
  if (!S.runId || !snap || !snap.run || Number(snap.run.id) !== S.runId) return;  // a late response for a run we navigated away from
  S.snap = normalizeSnap(snap);
  try { renderRun(); } catch (e) { console.error(e); }
  clearTimeout(S.poll);
  S.poll = setTimeout(refresh, S.snap.run.busy ? 600 : immediate ? 1200 : 2500);
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => { if (e.target.closest("[data-home]")) { e.preventDefault(); location.hash = "#/"; } });

// ------------------------------------------------------------------- topbar
function backendChip() {
  const b = obj((S.snap && S.snap.backend) || (S.status && S.status.backend));
  if (!Object.keys(b).length) return null;
  const models = [...new Set(Object.values(obj(b.models)).map(str).filter(Boolean))];
  return b.available ? h("span", { class: "chip dark", title: str(b.provider || b.label) }, h("span", { class: "dot ok" }), `Model: ${models.join(", ") || str(b.model) || "ready"}`)
    : h("span", { class: "chip dark", title: str(b.help || b.how_to_enable) }, h("span", { class: "dot off" }), "No model connected");
}
function renderTopbar() {
  if (S.view === "simple") return renderSimpleTopbar();
  const mid = clear($("#topbar-mid")), right = clear($("#topbar-right"));
  const runs = arr(S.status && S.status.runs).map(obj);
  if (S.snap && S.runId) {
    const r = S.snap.run;
    const sel = h("select", { onchange: (e) => (location.hash = `#/run/${e.target.value}`), "aria-label": "Switch run" },
      runs.map((x) => h("option", { value: x.id, selected: x.id === r.id }, `#${x.id} · ${str(x.product_name || x.idea).slice(0, 40)}`)));
    if (!runs.some((x) => x.id === r.id)) sel.prepend(h("option", { value: r.id, selected: true }, `#${r.id}`));
    mid.append(sel);
  }
  right.append(backendChip() || "", h("button", { class: "btn ghost sm", onclick: () => setView("simple") }, "Open simple view"),
    h("button", { class: "btn ghost sm", onclick: openStatus }, "Check model status"),
    h("button", { class: "btn ghost sm", onclick: () => (location.hash = "#/") }, "Start a new brief"));
}

// ---------------------------------------------------------------- run view
function ensureLayout() {
  if ($("#layout")) return;
  fill($("#app"), h("div", { class: "layout", id: "layout" },
    h("div", { class: "col side", id: "col-left" }),
    h("div", { class: "col", id: "col-main" },
      h("div", { id: "now" }), h("div", { class: "run-tabs x", id: "xtabs", role: "tablist", "aria-label": "Run details" }),
      h("div", { id: "board", role: "tabpanel" }), h("div", { id: "verdict", role: "tabpanel" }), h("div", { id: "ledger", role: "tabpanel" })),
    h("div", { class: "col side right", id: "col-right" },
      h("div", { class: "card" }, h("div", { class: "tabs", id: "tabs" }), h("div", { class: "feed", id: "feed" })))));
}

function renderRun() {
  const s = S.snap; if (!s) return;
  if (S.view === "simple") return renderSimpleRun();
  if (!$("#layout")) { clear($("#app")); }
  ensureLayout(); renderTopbar(); clear($("#banner")); renderCostBar();
  changed("left", [s.run.state, s.run.busy, s.approvals, s.hypotheses.length, s.run.product_name, s.build_unlocked, s.cost, s.last_activity,
    s.pending, phaseList(s).map((p) => [p.status, p.gates.map((g) => [g.name, g.outcome])]), s.refusals.length]) && renderLeft();
  renderNow();
  changed("board", [s.hypotheses, s.standing, S.filter.hyp, s.run.state, s.gaps]) && renderBoard();
  changed("verdict", [s.standing, s.standing_error, s.overrides, s.latest_verdict && s.latest_verdict.computed_at, s.run.state]) && renderVerdict();
  changed("ledger", [s.ledger, S.filter, [...S.expanded]]) && renderLedger();
  renderXTabs();
  renderFeed();
}
// Hypotheses, verdict and ledger share one slot under the Now panel; only the chosen one is shown.
const X_TABS = [["board", "Hypotheses"], ["verdict", "Verdict"], ["ledger", "Evidence ledger"]];
function renderXTabs() {
  const s = S.snap, have = X_TABS.filter(([id]) => $("#" + id).firstChild);
  if (!have.some(([id]) => id === S.xTab)) S.xTab = have.length ? have[0][0] : null;
  const n = { board: String(s.hypotheses.length), ledger: String(s.ledger.length), verdict: s.standing ? VERDICT_LABEL[s.standing.verdict] || "" : s.standing_error ? "Refused" : "" };
  syncTabs($("#xtabs"), have.map(([id]) => id), S.xTab, (id) => ({ sig: [n[id]],
    kids: [X_TABS.find((t) => t[0] === id)[1], n[id] ? h("span", { class: "rt-n" }, n[id]) : null] }), (id) => { S.xTab = id; renderRun(); }, "");
  $("#xtabs").hidden = !have.length;
  for (const [id] of X_TABS) $("#" + id).hidden = id !== S.xTab;
}
function changed(key, value) { const sig = JSON.stringify(value); if (S.sig[key] === sig) return false; S.sig[key] = sig; return true; }

// --------------------------------------------------------------- left col
const scrollToNow = (e) => { e.preventDefault(); $("#now").scrollIntoView({ behavior: "smooth" }); };
function renderLeft() {
  const s = S.snap, el = clear($("#col-left"));
  el.append(h("div", { class: "card" }, h("div", { class: "card-b" },
    h("div", { class: "eyebrow" }, `Run #${s.run.id}${s.run.product_name ? " · " + s.run.product_name : ""}`),
    h("div", { class: "idea-text" }, s.run.idea || s.brief.idea || ""),
    s.run.customer ? h("div", { class: "small muted" }, h("b", null, "Customer: "), s.run.customer) : null,
    runStats())));
  // phases and gates, compact
  el.append(h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "eyebrow" }, "Phases and gates")),
    h("div", { class: "card-b" }, h("ol", { class: "stepper" }, phaseList(s).map((p) => {
      const cls = p.status === "done" ? "done" : p.status === "active" ? (isStopped(s) ? "killed current" : "current") : p.status === "stopped" ? "killed current" : "";
      return h("li", { class: cls }, h("span", { class: "n" }, p.status === "done" ? "✓" : String(p.n)),
        h("div", { class: "ph-x" }, h("div", null, p.name, p.n === 1 && s.run.lock_hash ? h("span", { class: "muted small", title: s.run.lock_hash }, " · pass marks locked") : null),
          p.gates.length ? h("div", { class: "row small" }, p.gates.map((g) => h("span", { class: "gword o-" + str(g.outcome), title: str(g.reason) }, `${humanName(g.name)} ${OUTCOME_WORD[g.outcome] || "…"}`))) : null));
    })))));
  // waiting on you
  const items = [], kind = pendingKind(s);
  if (kind && !s.run.busy && !isStopped(s) && !isDone(s))
    items.push(h("div", { class: "qitem pending" }, h("span", { class: "k" }, "Gate"), h("span", { class: "t" }, (s.pending && s.pending.title) || s.step.label || humanName(kind)), h("a", { href: "#now", class: "s", onclick: scrollToNow }, "Go to it ↓")));
  for (const a of s.approvals.filter((x) => x.status === "pending"))
    items.push(h("div", { class: "qitem pending" }, h("span", { class: "k" }, "Outbound action · needs approval"), h("span", { class: "t" }, a.title), h("a", { href: "#now", class: "s", onclick: scrollToNow }, "Review ↓")));
  if (!items.length) items.push(h("div", { class: "empty small" }, isDone(s) ? "Nothing. All phases are complete." : isStopped(s) ? "Nothing. This run stopped." : "Nothing right now. It is the agents' turn."));
  el.append(h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "eyebrow" }, "Waiting on you")), h("div", { class: "card-b queue" }, items)));
  el.append(h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "eyebrow" }, "Approval queue · outbound actions")),
    h("div", { class: "card-b queue" }, s.approvals.length ? s.approvals.map((a) => h("div", { class: "qitem" },
      h("div", { class: "row" }, h("span", { class: "badge " + a.status }, a.status), h("span", { class: "small muted" }, time(a.decided_at || a.created_at))),
      h("span", { class: "s" }, a.title), a.note ? h("span", { class: "s muted" }, `“${a.note}”`) : null))
      : h("div", { class: "empty small" }, "Anything that would be published or sent waits here for you."))));
  el.append(h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "eyebrow" }, `Refusals (${s.refusals.length})`)),
    h("div", { class: "card-b queue" }, s.refusals.length ? s.refusals.slice().reverse().map(refusalCard)
      : h("div", { class: "empty small" }, "No requests refused in this run."))));
}

function runStats() {
  const s = S.snap, c = s.cost;
  const start = s.run.created_at, end = s.run.finished_at || (s.run.busy ? new Date().toISOString() : s.last_activity) || start;
  const secs = start ? Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000)) || 0 : 0;
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return h("dl", { class: "kv", style: "margin-top:8px" },
    h("dt", null, "Cost"), h("dd", { class: "num" }, `$${(Number(c.usd) || 0).toFixed(2)}`),
    h("dt", null, "Model calls"), h("dd", { class: "num" }, `${fmtInt(c.calls || s.model_calls.count)}${s.model_calls.failed ? ` (${s.model_calls.failed} failed)` : ""}`),
    h("dt", null, "Tokens"), h("dd", { class: "num" }, `${fmtInt(c.tokens_in)} in · ${fmtInt(c.tokens_out)} out`),
    c.models.length ? [h("dt", null, "Models"), h("dd", { class: "small" }, c.models.map(str).join(", "))] : null,
    h("dt", null, s.run.finished_at ? "Run took" : "Elapsed"), h("dd", { class: "num" }, dur),
    h("dt", null, "Currency"), h("dd", { class: "num" }, s.run.currency || s.brief.currency || "USD"));
}

// --------------------------------------------------------------- now panel
// The expert view keeps its own panels for the original gates and reuses the simple screens for the rest.
const EXPERT_NOW = { review_hypotheses: (b) => nowHypotheses(b), approve_landing: (b) => nowLanding(b), experiment: (b) => nowExperiment(b),
  review_spec: (b) => nowSpec(b), approve_product: (b) => nowProduct(b) };
function nowKey() {
  const s = S.snap, kind = pendingKind(s);
  return JSON.stringify([s.run.state, s.run.busy, s.run.error, s.approvals.map((a) => [a.id, a.status]), s.pending, s.improver,
    s.overrides.length, s.build_unlocked.ok, s.spec.map((r) => r.dropped), kind === "review_hypotheses" ? s.hypotheses : 0,
    kind === "confirm_brief" ? [s.brief, s.contract] : 0, kind || isStopped(s) || isDone(s) ? docsSig(s) : 0, S.kidOpen]);
}
function renderNow() {
  const s = S.snap, key = nowKey();
  if (key !== S.nowKey) {
    S.nowKey = key;
    const el = clear($("#now"));
    const body = h("div", { class: "card-b" });
    el.append(h("div", { class: "card now", "data-errhost": "" }, body));
    const kind = pendingKind(s), waiting = kind && !s.run.busy && !isStopped(s) && !isDone(s);
    add(body, h("div", { class: "now-head" }, h("span", { class: "eyebrow" }, isStopped(s) ? "Stopped" : isDone(s) ? "Done" : waiting ? "Your decision" : "Agents working"),
      h("span", { class: "now-label" }, (s.pending && s.pending.title) || s.step.label)));
    if (s.run.error) add(body, h("div", { class: "error" }, h("b", null, "Step failed. "), s.run.error));
    try {
      if (waiting && EXPERT_NOW[kind]) EXPERT_NOW[kind](body);
      else if (!s.run.busy && (waiting || isStopped(s) || isDone(s))) { const c = h("div", { class: "kid embed" }); body.append(c); kidScreen(c); }
      else nowAuto(body);
    } catch (e) { console.error(e); add(body, h("div", { class: "error" }, "This panel could not be shown. Try the simple view.")); }
    add(body, h("div", { class: "error inline-err", role: "alert", hidden: true }));
    if (waiting) body.append(askBox());
  }
  updateNowDynamic();
}
function updateNowDynamic() {
  const s = S.snap;
  kidDynamic();
  const tt = $("#traffic-table");
  if (tt) fill(tt, trafficTable());
}

function nowAuto(body) {
  const s = S.snap;
  if (s.run.busy) { const c = h("div", { class: "kid embed" }); body.append(c); kidBusy(c); return; }
  add(body, h("p", { class: "muted", style: "margin:0" }, s.step.can_retry ? `The run stopped before finishing ${s.step.graph_next.join(", ")}. Retrying re-runs it from the last checkpoint.` : "Waiting for the next step."),
    s.step.can_retry ? h("div", { class: "row" }, h("button", { class: "btn accent lg", onclick: () => act("POST", runPath("/retry"), null, "Retrying from the last checkpoint.") }, "Retry from last checkpoint")) : null);
}

// ---- hypotheses gate
const METRICS = ["supporting_entries", "refuting_entries", "support_share", "reserve_rate", "reserve_rate_at_price"];
const MIN_TIERS = ["stated_intent", "desk_research", "observed_pain", "commitment"];
function nowHypotheses(body) {
  const s = S.snap;
  if (!S.dirty || !S.draft) { S.draft = s.hypotheses.map((x) => ({ ...x, critical: !!x.critical })); S.dirty = false; }
  const list = h("div", { class: "hedit" });
  const mark = () => { S.dirty = true; };
  const draw = () => {
    fill(list, S.draft.map((hy, i) => {
      const upd = (k, conv = (v) => v) => (e) => { hy[k] = conv(e.target.type === "checkbox" ? e.target.checked : e.target.value); mark(); if (["metric"].includes(k)) draw(); else if (k === "threshold") $(`#pct-${i}`) && fill($(`#pct-${i}`), pctHint(hy)); };
      const sel = (k, opts, labels) => h("select", { onchange: upd(k) }, opts.map((o) => h("option", { value: o, selected: hy[k] === o }, labels ? labels[o] : o)));
      const server = s.hypotheses.find((x) => x.code === hy.code);
      return h("div", { class: "hcard" },
        h("div", { class: "top" }, h("span", { class: "code" }, hy.code || "new"),
          h("label", { class: "switch small" }, h("input", { type: "checkbox", checked: !!hy.critical, onchange: upd("critical") }), "critical (refuted ⇒ kill)"),
          h("span", { class: "spacer" }), h("button", { class: "btn ghost sm", onclick: () => { S.draft.splice(i, 1); mark(); draw(); } }, "Delete")),
        h("textarea", { rows: 2, oninput: upd("statement") }, hy.statement || ""),
        h("div", { class: "fields" },
          h("label", { class: "f" }, "Metric", sel("metric", METRICS, METRIC_LABEL)),
          h("label", { class: "f" }, "Comparator", sel("comparator", [">=", "<="])),
          h("label", { class: "f" }, h("span", null, "Threshold ", h("span", { id: `pct-${i}`, class: "muted" }, pctHint(hy))), h("input", { type: "number", step: "any", value: hy.threshold, oninput: upd("threshold", Number) })),
          h("label", { class: "f" }, "Min sample", h("input", { type: "number", min: 1, step: 1, value: hy.min_sample, oninput: upd("min_sample", Number) })),
          h("label", { class: "f" }, "Min evidence tier", sel("min_tier", MIN_TIERS, TIER_LABEL)),
          hy.metric === "reserve_rate_at_price" ? h("label", { class: "f" }, "Price floor", h("input", { type: "number", step: "any", value: hy.price_floor ?? "", oninput: upd("price_floor", (v) => (v === "" ? null : Number(v))) })) : h("span")),
        hy.rationale ? h("div", { class: "small muted" }, h("b", null, "Agent's rationale: "), hy.rationale) : null,
        server && server.problems.length && !S.dirty ? h("div", { class: "problems" }, "Fix before locking: " + server.problems.join("; ")) : null);
    }));
  };
  draw();
  const save = async () => { const r = await act("PUT", runPath("/hypotheses"), { hypotheses: S.draft }, "Saved. Edits are in the decision log."); if (r) { S.dirty = false; S.nowKey = null; renderNow(); } return r; };
  add(body, h("p", { class: "muted", style: "margin:0" }, "Each hypothesis is judged by code from the ledger. Below its minimum sample it is “insufficient evidence”, never supported or refuted. Approving locks them: a SHA-256 of this exact set is stored and re-checked, so the pass marks cannot be changed or lowered later."),
    list,
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { S.draft.push({ statement: "", metric: "supporting_entries", comparator: ">=", threshold: 3, min_sample: 3, min_tier: "observed_pain", price_floor: null, critical: false, rationale: "" }); mark(); draw(); } }, "Add a hypothesis"),
      h("button", { class: "btn ghost", onclick: save }, "Save edits"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn accent lg", onclick: async () => { if (S.dirty && !(await save())) return; S.dirty = false; act("POST", runPath("/hypotheses/approve"), null, "Locked. The hash is in the decision log."); } }, "Approve and lock")));
}
function pctHint(hy) { return SHARE.has(hy.metric) && hy.threshold !== "" ? `(= ${(Number(hy.threshold) * 100).toFixed(1).replace(/\.0$/, "")}%)` : ""; }

// ---- landing approval
function approvalButtons(body, approval, approveLabel) {
  const note = h("input", { type: "text", placeholder: "Reason for rejecting (sent to the agent)", style: "flex:1;min-width:220px" });
  add(body, h("div", { class: "row" },
    h("button", { class: "btn accent lg", onclick: () => act("POST", runPath(`/approvals/${approval.id}`), { approve: true }, "Approved and published.") }, approveLabel),
    note, h("button", { class: "btn ghost", onclick: () => act("POST", runPath(`/approvals/${approval.id}`), { approve: false, note: note.value }, "Rejected. The agent will redraft.") }, "Reject")));
}
function nowLanding(body) {
  const s = S.snap, a = s.approvals.find((x) => x.kind === "publish_landing" && x.status === "pending");
  const cfg = obj(obj(s.landing).config);
  add(body, h("div", { class: "note" }, "Approving is an outbound action, so it waits here. The page is a fixed template filled from a validated config the Copywriter wrote. After someone registers interest it says plainly that nothing is charged."),
    mockNote("MOCKED"),
    h("div", { class: "row small" }, h("b", null, "Price points:"), arr(cfg.price_points).map((p) => h("span", { class: "badge outline" }, `${str(p.name)} ${str(cfg.currency_symbol)}${str(p.price)} ${str(p.billing)}`)),
      h("span", { class: "spacer" }), s.run.slug ? h("a", { href: `/p/${s.run.slug}?preview=1`, target: "_blank" }, "Open preview in a new tab") : null),
    s.run.slug ? frameBox(`/p/${s.run.slug}?preview=1`, "frame", "Landing page preview") : null);
  if (a) approvalButtons(body, a, "Approve page");
}

// ---- demand test gate
function trafficTable() {
  const s = S.snap;
  if (!s.traffic.length) return h("div", { class: "empty small" }, "No visits yet.");
  return h("table", { class: "t" }, h("thead", null, h("tr", null, ["Source", "Visitors", "Registrations", "Counts?"].map((x) => h("th", null, x)))),
    h("tbody", null, s.traffic.map((t) => h("tr", { class: t.excluded ? "excluded" : "" }, h("td", null, str(t.source)), h("td", { class: "num" }, str(t.visitors)), h("td", { class: "num" }, str(t.commitments)),
      h("td", null, t.excluded ? h("span", { class: "warnc" }, "no, your own visits") : h("span", { class: "ok" }, "yes"))))));
}
function nowExperiment(body) {
  const s = S.snap, slug = s.run.slug, demand = allGates(s).filter((g) => g.name === "demand").pop();
  const ovValue = h("select", null, h("option", { value: "go" }, "Go: go on to the build"), h("option", { value: "kill" }, "Stop: stop this idea"));
  const ovReason = h("textarea", { rows: 2, placeholder: "Written reason (required, kept for good next to the result)" });
  add(body, h("div", { class: "grid2" },
    h("div", { class: "sub" }, h("h4", null, "Test page on this computer"),
      slug ? h("div", { class: "small" }, h("a", { href: `/p/${slug}`, target: "_blank" }, `/p/${slug}`)) : null,
      h("div", { class: "small muted" }, "Only real visits and registrations count. This browser carries the founder cookie, so your own visits are tagged as yours and never count. Every counted visit is a real one."),
      mockNote("MOCKED")),
    h("div", { class: "sub" }, h("h4", null, "Visits by source"), h("div", { id: "traffic-table" }))),
    demand ? gateCard(demand) : null,
    h("div", { class: "sub" }, h("h4", null, "Decide"),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => act("POST", runPath("/verdict"), null, "Result computed and recorded.") }, "Compute and record the result"),
        h("button", { class: "btn accent", disabled: !s.build_unlocked.ok, onclick: () => act("POST", runPath("/proceed"), null, "On to the build.") }, "Go on to the build"),
        h("span", { class: "small muted" }, str(s.build_unlocked.reason))),
      h("div", { class: "row", style: "align-items:flex-start" }, h("label", { class: "f", style: "flex:0 0 auto" }, "Override to", ovValue), h("label", { class: "f", style: "flex:1;min-width:240px" }, "Reason", ovReason),
        h("button", { class: "btn danger", style: "margin-top:16px", onclick: () => act("POST", runPath("/override"), { value: ovValue.value, reason: ovReason.value }, "Override recorded for good.") }, "Record override"))));
}

// ---- spec gate
function citeChip(code, bad) { return h("span", { class: "cite" + (bad ? " badc" : ""), title: "Show in ledger", onclick: () => focusEntry(code) }, code); }
function nowSpec(body) {
  const s = S.snap, acc = s.spec.filter((r) => r.accepted), rej = s.spec.filter((r) => !r.accepted);
  add(body, h("p", { class: "muted", style: "margin:0" }, "Code checked every citation. Priority comes from the strongest evidence each requirement cites (Commitment → P0, Pain or intent → P1, Desk research → P2)."),
    h("div", { class: "reqs" }, acc.map((r) => h("div", { class: "req" + (r.dropped ? " dropped" : "") },
      h("span", { class: "code" }, r.code),
      h("div", null, h("div", null, inline(r.text)), h("div", { class: "small muted" }, str(r.rationale)),
        h("div", { class: "row small", style: "margin-top:4px" }, "Cites:", arr(r.cites).map((c) => citeChip(c, !arr(r.valid_cites).includes(c))), h("span", { class: "muted" }, str(r.priority_basis)))),
      h("div", { class: "row" }, h("span", { class: "prio " + r.priority }, str(r.priority)),
        h("button", { class: "btn ghost sm", onclick: () => act("POST", runPath(`/spec/${r.code}`), { dropped: !r.dropped }) }, r.dropped ? "Restore" : "Drop"))))),
    rej.length ? h("div", null, h("div", { class: "eyebrow", style: "margin:4px 0 6px;color:var(--ref)" }, `Rejected by the citation check (code) · ${rej.length}`),
      h("div", { class: "reqs" }, rej.map((r) => h("div", { class: "req rejected" }, h("span", { class: "code" }, r.code),
        h("div", null, h("div", { class: "strike" }, str(r.text)), h("div", { class: "small bad" }, str(r.rejection)),
          h("div", { class: "row small", style: "margin-top:4px" }, "Cited:", arr(r.cites).length ? arr(r.cites).map((c) => citeChip(c, true)) : h("span", { class: "muted" }, "nothing"))), h("span"))))) : null,
    acc.some((r) => !r.dropped) ? h("div", null, h("button", { class: "btn accent lg", onclick: () => act("POST", runPath("/spec/approve"), null, "Spec approved.") }, "Approve spec"))
      : specDeadEnd(rej));
}
// Nothing passed the citation check: the founder stops, or builds the rejected requirements as ASSUMPTIONS.
function specDeadEnd(rej) {
  const buildable = rej.filter((r) => !arr(r.unsupported).length && !r.dropped);
  const reason = h("textarea", { rows: 2, placeholder: "Written reason (required): what you know that the evidence does not" });
  return h("div", { class: "sub" }, h("h4", null, "No requirement cites verified evidence"),
    h("p", { class: "small muted" }, "Code accepted nothing to build. Stop here, or build the rejected requirements as ASSUMPTIONS: they get low priority (P2), an ASSUMPTION label, and the code's verdict stays on record beside your reason."),
    buildable.length ? reason : null,
    h("div", { class: "row" },
      buildable.length ? h("button", { class: "btn", onclick: () => act("POST", runPath("/spec/assume"), { reason: reason.value }, "Building the requirements as ASSUMPTIONS.") }, `Accept ${buildable.length} as ASSUMPTION and build`) : null,
      h("button", { class: "btn danger", onclick: () => act("POST", runPath("/spec/stop"), { reason: buildable.length ? reason.value : "" }, "Stopped at spec review.") }, "Stop here")));
}

// ---- product approval
function nowProduct(body) {
  const s = S.snap, a = s.approvals.find((x) => x.kind === "publish_product" && x.status === "pending"), prod = obj(s.product);
  add(body, h("div", { class: "note" }, "The Builder filled a product template through a validated config. Every input and output traces to an approved requirement, and formulas run in a safe evaluator."),
    arr(prod.build_notes).length ? h("div", { class: "small" }, arr(prod.build_notes).map((n) => h("div", null, "• " + str(n)))) : null,
    s.run.slug ? [h("div", { class: "row small" }, h("span", { class: "spacer" }), h("a", { href: `/app/${s.run.slug}?preview=1`, target: "_blank" }, "Open preview in a new tab")),
      frameBox(`/app/${s.run.slug}?preview=1`, "frame", "Product preview")] : null,
    ["test_report", "user_guide"].map((n) => stepBy(s, n)).filter(Boolean).map((st) => artifactDetails(st)));
  if (a) approvalButtons(body, a, "Approve product");
}

// --------------------------------------------------------------- scoreboard
function renderBoard() {
  const s = S.snap, el = clear($("#board"));
  if (!s.hypotheses.length) return;
  const res = {}; (s.standing ? s.standing.hypotheses : []).forEach((r) => (res[r.code] = r));
  const card = h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "section-title" }, "Hypotheses"),
    h("span", { class: "small muted" }, s.run.lock_hash ? "Live standing, computed by code from the ledger · click one to see its evidence" : "Drafts — not locked yet")),
    h("div", { class: "card-b" }, h("div", { class: "scoreboard" }, s.hypotheses.map((hy) => {
      const r = res[hy.code], status = r ? r.status : "draft";
      const v = r && r.value != null ? Number(r.value) : 0, t = Number(hy.threshold);
      const max = Math.max(t * 1.6, v, SHARE.has(hy.metric) ? 0.01 : 1);
      const counted = r ? arr(r.counted) : [];
      const byTier = {}; counted.forEach((c) => { const e = s.ledger.find((x) => x.code === c); if (e) byTier[e.tier] = (byTier[e.tier] || 0) + 1; });
      return h("div", { class: `hyp ${status}${S.filter.hyp === hy.code ? " sel" : ""}`, onclick: () => { S.filter.hyp = S.filter.hyp === hy.code ? null : hy.code; if (S.filter.hyp) S.xTab = "ledger"; renderRun(); } },
        h("div", { class: "head" }, h("span", { class: "code" }, hy.code), hy.critical ? h("span", { class: "badge critical" }, "critical") : null, h("span", { class: "status " + status }, status === "insufficient" ? "insufficient" : status)),
        h("div", { class: "stmt" }, hy.statement),
        h("div", { class: "rule" }, `${METRIC_LABEL[hy.metric]} ${fmtThreshold(hy)} · n ≥ ${hy.min_sample}${hy.price_floor ? ` · price ≥ ${hy.price_floor}` : ""} · ${TIER_LABEL[hy.min_tier]}+`),
        r ? h("div", { class: "meter" }, h("span", { class: "fill", style: `width:${Math.min(100, (v / max) * 100)}%` }), h("span", { class: "mark", style: `left:${Math.min(100, (t / max) * 100)}%`, title: "threshold" })) : null,
        r ? h("div", { class: "val" }, h("span", null, h("b", null, r.value_label), ` · n=${r.sample}/${r.min_sample}`), h("span", null, arr(r.excluded).length ? `${arr(r.excluded).length} excluded` : "")) : null,
        Object.keys(byTier).length ? h("div", { class: "tierbar" }, Object.entries(byTier).map(([t2, n]) => h("span", { class: "tier " + t2 }, `${TIER_LABEL[t2]} ×${n}`))) : null,
        gapNote(hy, status));
    }))));
  el.append(card);
}

function gapNote(hy, status) {
  const g = S.snap.gaps, open = arr(g.open).find((x) => x.code === hy.code);
  if (!S.snap.run.lock_hash || ["reserve_rate", "reserve_rate_at_price"].includes(hy.metric)) return null;
  if (open && status === "insufficient")
    return h("div", { class: "small", style: "color:var(--ins)" }, `Still missing ${open.need} verified ${open.tier_label}+ ${open.need === 1 ? "entry" : "entries"} · gap rounds tried ${g.rounds}/${g.cap}`);
  if (g.rounds && status !== "insufficient") return h("div", { class: "small muted" }, `Minimum sample reached · this run used ${g.rounds} gap round${g.rounds === 1 ? "" : "s"}`);
  return null;
}

// ------------------------------------------------------------------ verdict
function renderVerdict() {
  const s = S.snap, el = clear($("#verdict"));
  if (!s.run.lock_hash) return;
  const v = s.standing;
  if (!v && !s.standing_error) return;
  const stamp = s.standing_error ? h("div", { class: "stamp refused" }, "Refused", h("small", null, "lock hash mismatch"))
    : h("div", { class: "stamp " + v.verdict }, VERDICT_LABEL[v.verdict], h("small", null, "computed by code"));
  const overrides = s.overrides.map((o) => h("div", { class: "override" + (o.kind === "count_test_traffic" ? " mild" : "") },
    h("div", { class: "k" }, o.kind === "verdict" ? `Founder override · computed ${str(o.computed_verdict).replace(/_/g, " ")} → ${str(o.value)}` : `Override · ${humanName(o.kind)} ${str(o.value)}`),
    h("div", null, `“${str(o.reason)}”`), h("div", { class: "small muted" }, (o.ts ? new Date(o.ts).toLocaleString() : "") + " · permanent")));
  const details = v ? h("details", { class: "calc", open: s.run.state === "experiment" ? true : null },
    h("summary", null, "Show exactly how it was computed"),
    arr(v.hypotheses).map((r) => h("div", { class: "calc-row" }, h("span", { class: "code" }, r.code),
      h("div", null, h("div", null, h("span", { class: "status " + r.status, style: "margin:0 6px 0 0" }, r.status), h("span", { class: "num" }, r.formula), h("span", { class: "muted" }, `  vs ${r.threshold_label}, min n ${r.min_sample}`)),
        h("div", { class: "small" }, r.explanation),
        r.traffic ? h("div", { class: "small muted" }, `Counted visitors: ${r.traffic.counted_visitors}. Not counted: ${Object.entries(obj(r.traffic.excluded_visitors)).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`) : null,
        h("div", { class: "row small", style: "margin-top:3px" }, "Counted:", arr(r.counted).length ? arr(r.counted).map((c) => citeChip(c)) : h("span", { class: "muted" }, "none")),
        arr(r.excluded).length ? h("div", { class: "small muted" }, arr(r.excluded).slice(0, 8).map((x) => h("div", null, h("b", null, x.code), " — " + x.reason)), r.excluded.length > 8 ? h("div", null, `…and ${r.excluded.length - 8} more`) : null) : null)))) : null;
  el.append(h("div", { class: "card" }, h("div", { class: "card-h" }, h("div", { class: "section-title" }, "Verdict"),
    h("span", { class: "small muted" }, s.latest_verdict ? `Last recorded computation ${time(s.latest_verdict.computed_at)} · ${VERDICT_LABEL[s.latest_verdict.verdict] || ""}` : "Live preview. Record it from the Decide panel.")),
    h("div", { class: "card-b" }, h("div", { class: "verdict" }, h("div", null, stamp),
      h("div", { style: "display:flex;flex-direction:column;gap:9px" },
        s.standing_error ? h("div", { class: "error" }, s.standing_error) : h("div", { style: "font:16px/1.4 var(--serif)" }, str(v.rule)),
        h("div", { class: "lockline" }, "🔒 Locked set SHA-256 ", h("span", { title: s.run.lock_hash }, s.run.lock_hash.slice(0, 16) + "…"), h("span", null, "· re-checked before every computation")),
        v ? h("ol", { class: "rulelist" }, arr(v.decision_rule).map((d, i) => h("li", { class: i === v.rule_index ? "applied" : "" }, `${VERDICT_LABEL[d.verdict]} — ${d.text}`))) : null,
        v && Object.keys(obj(v.test_visits)).length ? h("div", { class: "small muted" }, "Your own visits, not counted: " + Object.entries(obj(v.test_visits)).map(([k, n]) => `${n} ${k}`).join(", ")) : null,
        overrides, details)))));
}

// ------------------------------------------------------------------- ledger
function focusEntry(code) {
  S.filter.hyp = null; S.filter.view = "all";
  const e = S.snap.ledger.find((x) => x.code === code);
  if (e && e.is_test_traffic) S.filter.showTest = true;
  S.sig.ledger = null; S.xTab = "ledger"; renderRun();
  const row = document.getElementById("entry-" + code);
  if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); }
}
function renderLedger() {
  const s = S.snap, el = clear($("#ledger"));
  if (!s.ledger.length && !s.run.lock_hash) return;
  const f = S.filter;
  const testN = s.ledger.filter((e) => e.is_test_traffic).length;
  let rows = s.ledger.filter((e) => f.showTest || !e.is_test_traffic);
  if (f.hyp) rows = rows.filter((e) => e.hypothesis_codes.includes(f.hyp));
  if (f.view === "counted") rows = rows.filter((e) => (f.hyp ? e.counts_for.includes(f.hyp) : e.counts_for.length));
  if (f.view === "excluded") rows = rows.filter((e) => (f.hyp ? e.excluded_for.some((x) => x.code === f.hyp) : !e.counts_for.length));
  const verified = s.ledger.filter((e) => e.verification === "verified").length;
  const chip = (label, on, fn) => h("button", { class: "fchip" + (on ? " on" : ""), onclick: fn }, label);
  const set = (k, v) => () => { S.filter[k] = v; renderRun(); };
  el.append(h("div", { class: "card" },
    h("div", { class: "card-h" }, h("div", { class: "section-title" }, "Evidence ledger"),
      h("span", { class: "small muted" }, `${s.ledger.length} entries · ${verified} verified · tiers: LLM opinion 0 → Commitment 4`)),
    h("div", { class: "card-b", style: "padding-bottom:6px" }, h("div", { class: "filters" },
      chip("All hypotheses", !f.hyp, set("hyp", null)), s.hypotheses.map((hy) => chip(hy.code, f.hyp === hy.code, set("hyp", hy.code))),
      h("span", { class: "muted" }, "·"), chip("Everything", f.view === "all", set("view", "all")), chip("Counted", f.view === "counted", set("view", "counted")), chip("Excluded", f.view === "excluded", set("view", "excluded")),
      testN ? chip(`${f.showTest ? "Hide" : "Show"} test traffic (${testN})`, f.showTest, set("showTest", !f.showTest)) : null)),
    h("div", { class: "ledger" }, rows.length ? rows.map(entryRow) : h("div", { class: "empty", style: "padding:14px" }, s.ledger.length ? "No entries match this filter." : "The ledger is empty. Scouts will fill it."))));
}
function entryRow(e) {
  const countsAll = e.counts_for.length > 0;
  const tierBadge = h("span", { class: "tier " + e.tier }, TIER_LABEL[e.tier], h("span", { class: "w" }, `w${TIER_W[e.tier]}`));
  const ver = e.verification === "verified" ? h("span", { class: "ok" }, "✓ verified") : e.verification === "no_source" ? h("span", { class: "muted" }, "— no source") : e.verification === "pending" ? h("span", { class: "warnc" }, "… not checked yet") : h("span", { class: "bad" }, "✗ unverified");
  const meta = e.meta || {};
  const source = e.source_kind === "hn" ? h("a", { href: e.source_url, target: "_blank", rel: "noopener" }, `HN item ${meta.hn_id || ""} ↗`)
    : e.source_kind === "web" ? h("a", { href: e.source_url, target: "_blank", rel: "noopener noreferrer" }, `${meta.host || "web page"} ↗`)
    : e.source_kind === "landing" ? h("span", null, `Reserve click · ${e.traffic_source} · visitor ${String(meta.visitor_id || "").slice(0, 8)}`)
    : e.source_kind === "product" ? h("span", null, `Get-access click on the product · ${e.traffic_source} · visitor ${String(meta.visitor_id || "").slice(0, 8)}`)
    : h("span", null, "Model output, no source");
  const long = e.quote && e.quote.length > 220 && !S.expanded.has(e.code);
  return h("div", { class: `entry t-${e.tier}${countsAll || !S.snap.run.lock_hash ? "" : " excluded-all"}`, id: "entry-" + e.code },
    h("div", null, h("div", { class: "code" }, e.code)),
    h("div", { class: "tiercol" }, tierBadge,
      e.original_tier !== e.tier ? h("div", { class: "small muted", style: "margin-top:4px" }, "was ", h("span", { class: "strike" }, TIER_LABEL[e.original_tier])) : null,
      h("div", { class: "stance " + e.stance, style: "margin-top:5px" }, (e.stance === "supports" ? "▲ supports " : "▼ refutes ") + e.hypothesis_codes.join(", "))),
    h("div", { class: "bodycol" }, h("div", { class: "claim" }, e.claim),
      e.quote ? h("blockquote", null, "“" + (long ? e.quote.slice(0, 220) + "…" : e.quote) + "”", long ? h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); S.expanded.add(e.code); S.sig.ledger = null; renderRun(); } }, " more") : null) : null,
      h("div", { class: "meta" }, source, h("span", null, "· " + e.agent), e.fetched_at ? h("span", { title: e.fetched_at }, "· fetched " + e.fetched_at.slice(0, 10)) : null)),
    h("div", { class: "checks" }, ver,
      e.verification_note && e.verification !== "verified" ? h("div", { class: "why" }, e.verification_note) : null,
      e.downgrade_reason ? h("div", { class: "why" }, h("b", null, "Skeptic downgraded: "), e.downgrade_reason) : null,
      Object.entries(e.skeptic_flags || {}).map(([k, why]) => h("div", { class: "why" }, h("b", null, `Skeptic flag on ${k}: `), why)),
      S.snap.run.lock_hash ? [e.counts_for.length ? h("div", { class: "ok small" }, "Counts for " + e.counts_for.join(", ")) : null,
        e.excluded_for.map((x) => h("div", { class: "why" }, h("b", null, `Not counted for ${x.code}: `), x.reason.startsWith("skeptic:") ? "skeptic flag (above)" : x.reason))] : null));
}

// -------------------------------------------------------------- trace / log
const AGENT_COLORS = ["var(--blue)", "var(--ink)", "var(--ink-soft)", "var(--orange-text)"];
function agentColor(name) { let x = 0; for (const c of str(name)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return AGENT_COLORS[x % AGENT_COLORS.length]; }
function renderFeed() {
  const s = S.snap, tabs = clear($("#tabs")), feed = $("#feed");
  const tab = (id, label, n) => h("button", { class: "tab" + (S.tab === id ? " on" : ""), onclick: () => { S.tab = id; S.seen = { trace: 0, decisions: 0 }; clear(feed); renderFeed(); } }, `${label} (${n})`);
  tabs.append(tab("trace", "Agent trace", s.trace.length), tab("decisions", "Decision log", s.decisions.length));
  const list = S.tab === "trace" ? s.trace : s.decisions;
  const seen = S.seen[S.tab];
  if (list.length < seen) { clear(feed); S.seen[S.tab] = 0; }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  if (S.seen[S.tab] === 0) clear(feed);
  for (const item of list.slice(S.seen[S.tab])) {
    if (S.tab === "trace") {
      const codey = /\(code\)|LangGraph|gate|guard|Landing page|Product page/.test(str(item.agent));
      const tool = str(item.action).startsWith("tool ·");
      feed.append(h("div", { class: "tline" + (codey ? " code-agent" : "") + (tool ? " tool" : "") + (seen ? " fresh" : "") },
        h("span", { class: "ts" }, time(item.ts)),
        h("div", null, h("div", { class: "who" }, h("span", { class: "dot", style: `color:${codey ? "var(--accent)" : agentColor(item.agent)}` }), item.agent, h("span", { class: "act" }, "· " + item.action)),
          item.detail ? h("div", { class: "det" }, item.detail) : null)));
    } else {
      const isOv = str(item.kind).startsWith("override");
      feed.append(h("div", { class: "tline" + (isOv ? " override-row" : "") + (seen ? " fresh" : "") },
        h("span", { class: "ts" }, time(item.ts)),
        h("div", null, h("div", { class: "who" }, h("span", { class: "badge " + (isOv ? "rejected" : item.actor === "code" ? "outline" : "approved") }, item.actor), h("span", { class: "muted small" }, str(item.kind).replace(/_/g, " "))),
          h("div", { class: "det" }, item.summary))));
    }
  }
  if (list.length > S.seen[S.tab] && (atBottom || !seen)) feed.scrollTop = feed.scrollHeight;
  S.seen[S.tab] = list.length;
  if (!list.length) fill(feed, h("div", { class: "empty" }, S.tab === "trace" ? "No agent actions yet." : "No decisions yet."));
}

// ------------------------------------------------------------ status panel
async function openStatus() {
  const box = h("div", { class: "card-b" }, h("div", { class: "running" }, h("span", { class: "spin" }), "Checking the model connection and the network…"));
  const close = () => overlay.remove();
  const overlay = h("div", { class: "modal", onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "card modal-card" }, h("div", { class: "card-h" }, h("div", { class: "section-title" }, "Model status"),
      h("button", { class: "btn ghost sm", onclick: close }, "Close")), box));
  document.body.append(overlay);
  let res;
  try { res = await api("GET", "/api/health"); } catch (e) { fill(box, h("div", { class: "error" }, e.message)); return; }
  const result = h("div", { class: "small" });
  const test = h("button", { class: "btn ghost sm", onclick: async () => {
    test.disabled = true; fill(result, h("span", { class: "running" }, h("span", { class: "spin" }), "Running one tiny model call…"));
    let r = await api("POST", "/api/health/test-call").catch((e) => ({ ok: false, error: e.message }));
    r = obj(r); fill(result, r.ok ? h("span", { class: "ok" }, `✓ Model call succeeded in ${r.seconds}s (${r.model}).`) : h("span", { class: "bad" }, `✗ ${r.error || "Model call failed."}`));
    test.disabled = false;
  } }, "Run a test model call");
  fill(box,
    h("p", { class: "muted", style: "margin:0 0 8px" }, res && res.ready ? "Ready." : "The model connection needs attention."),
    modelLine(obj(S.status && S.status.backend)),
    h("table", { class: "t" }, h("tbody", null, arr(res && res.checks).map(obj).map((c) => h("tr", null,
      h("td", { style: "width:26px" }, c.ok ? h("span", { class: "ok" }, "✓") : h("span", { class: "bad" }, "✗")),
      h("td", null, h("b", null, c.name), h("div", { class: "muted" }, c.detail), c.fix ? h("div", { class: "bad" }, "What to do: " + c.fix) : null))))),
    h("div", { class: "row", style: "margin-top:10px" }, test, h("span", { class: "muted small" }, "Makes one short call to the open-weight model."), result),
    h("p", { class: "small muted", style: "margin:10px 0 0" }, "Models write drafts only. Searching and checking sources is done by code, and every gate is decided by code."));
}

route();

// Keep the sticky tab bar flush under the top bar, whatever height the top bar has.
(() => {
  const bar = document.querySelector(".topbar");
  if (!bar || !window.ResizeObserver) return;
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", bar.offsetHeight + "px")).observe(bar);
})();
