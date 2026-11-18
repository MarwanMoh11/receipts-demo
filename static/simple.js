"use strict";
/* Simple view: one step per screen, plain words. It uses the helpers in app.js (h, $, add, clear,
   fill, act, api, runPath, toast, refresh) and the shared pieces in parts.js. The screen is chosen
   by snapshot.pending.kind. All agent- and web-sourced text goes through h() or md() as text. */

const KID_NOUN = {
  desk_research: ["article or report", "articles or reports"],
  observed_pain: ["person describing this problem", "people describing this problem"],
  stated_intent: ["person saying they would use it", "people saying they would use it"],
  commitment: ["real registration", "real registrations"],
};
const KID_STATUS = { supported: ["", "Met"], refuted: ["", "Not met"], insufficient: ["", "Not enough evidence yet"], draft: ["", "Not checked yet"] };
const KID_ANSWER = {
  go: ["Every pass mark was met, with enough evidence."],
  pivot: ["Nothing critical failed, but some pass marks were not met."],
  kill: ["A pass mark that had to be met was not met."],
  insufficient_evidence: ["There is not enough evidence yet to say yes or no."],
  refused: ["The locked pass marks no longer match, so no result can be given."],
};
const KID_VERDICT_WORD = { go: "go", pivot: "pivot", kill: "stop", insufficient_evidence: "stop", refused: "stop" };
const KID_PRIORITY = { P0: "Must have", P1: "Should have", P2: "Nice to have" };

const kidPct = (x) => `${Math.round(Number(x) * 1000) / 10}%`;
const kidRESERVE = new Set(["reserve_rate", "reserve_rate_at_price"]);

function plainGoal(hy) {
  const t = Number(hy.threshold), n = hy.min_sample, noun = KID_NOUN[hy.min_tier] || KID_NOUN.desk_research;
  const sym = (S.snap && S.snap.currency_symbol) || "$";
  switch (hy.metric) {
    case "supporting_entries": return `Pass mark: at least ${t} ${t === 1 ? noun[0] : noun[1]}, each from a checked source.`;
    case "refuting_entries": return `Pass mark: out of ${n} or more ${noun[1]}, no more than ${t} disagree.`;
    case "support_share": return `Pass mark: out of ${n} or more ${noun[1]}, at least ${kidPct(t)} agree.`;
    case "reserve_rate": return `Pass mark: out of ${n} or more real visitors to your test page, at least ${kidPct(t)} register.`;
    case "reserve_rate_at_price": return `Pass mark: out of ${n} or more real visitors, at least ${kidPct(t)} register at ${sym}${hy.price_floor} or more.`;
    default: return "";
  }
}

function setView(v) {
  S.view = v;
  try { localStorage.setItem("rc_view", v); } catch (_) { /* per-browser convenience only */ }
  S.sig = {}; S.nowKey = null; S.kidKey = null; S.kidOpen = null;
  clear($("#app"));
  if (S.snap && S.runId) renderRun();  // draw the other view at once; route() then refreshes it
  route();
}

// ------------------------------------------------------------------ topbar
function renderSimpleTopbar() {
  const mid = clear($("#topbar-mid")), right = clear($("#topbar-right"));
  const b = obj((S.snap && S.snap.backend) || (S.status && S.status.backend));
  if (S.snap && S.runId) mid.append(h("span", { class: "kid-hide-sm topbar-run" }, `Run ${S.snap.run.id}`));
  right.append(
    Object.keys(b).length ? h("button", { class: "kid-topbtn", onclick: openStatus, title: "Check the model connection" },
      h("span", { class: "dot " + (b.available ? "ok" : "off") }), h("span", { class: "kid-hide-sm" }, b.available ? "Model ready" : "No model")) : "",
    h("button", { class: "kid-topbtn", onclick: () => setView("expert") }, "Expert view"),
    S.runId || /^#\/recorded/.test(location.hash) ? h("button", { class: "kid-topbtn strong", onclick: () => (location.hash = "#/") }, "New brief") : "");
}

// --------------------------------------------------------------- run page
// One screen per run: the step that needs you ("Now") first; past work sits behind tabs.
const KID_TABS = [["now", "Now"], ["checks", "Pass marks"], ["docs", "Documents"], ["activity", "Activity"], ["refusals", "Refusals"]];
function renderSimpleRun() {
  const s = S.snap;
  if (!$("#kid-run")) {
    const panel = (id, ...kids) => h("section", { class: "run-panel", id: "tab-" + id, role: "tabpanel" }, kids);
    fill($("#app"), h("div", { class: "kid kid-runw", id: "kid-run" },
      h("div", { id: "kid-phases" }), h("div", { id: "kid-top" }),
      h("div", { class: "run-tabs", id: "kid-tabs", role: "tablist", "aria-label": "Run sections" }),
      panel("now", h("div", { id: "kid-main" }), h("div", { id: "kid-ask" })),
      panel("checks", h("div", { id: "kid-checks" })), panel("docs", h("div", { id: "kid-docs" })),
      panel("activity", h("div", { id: "kid-activity" })), panel("refusals", h("div", { id: "kid-refusals" })),
      h("div", { class: "kid-foot" }, h("button", { class: "linkish", onclick: () => setView("expert") }, "See every detail in the expert view"))));
    S.sig = {}; S.kidKey = null;
  }
  renderSimpleTopbar(); clear($("#banner")); renderCostBar();
  changed("kid-phases", [s.run.id, s.run.state, phaseList(s).map((p) => [p.status, p.gates.map((g) => g.outcome)])]) && fill($("#kid-phases"), phaseStrip(s));
  changed("kid-top", [s.run.id, s.run.idea, s.brief.idea]) && kidTop();
  const key = kidKey();
  if (key !== S.kidKey) { S.kidKey = key; kidMain(); }
  kidDynamic();
  const atGate = !s.run.busy && !!pendingKind(s) && !isStopped(s) && !isDone(s);
  changed("kid-ask", [s.run.id, atGate, pendingKind(s), pendingPhase(s)]) && fill($("#kid-ask"), atGate ? askBox() : null);
  changed("kid-refusals", [s.run.id, s.refusals.length]) && fill($("#kid-refusals"), refusalsSection(s));
  changed("kid-checks", [s.run.id, s.hypotheses, s.standing, s.run.state, s.run.lock_hash, s.ledger.length]) && kidChecks();
  changed("kid-docs", [s.run.id, docsSig(s), S.docPhase]) && kidDocs();
  changed("kid-activity", [s.run.id, s.trace.length, s.decisions.length, S.actView]) && kidActivity();
  kidTabs(atGate);
}

// The tab bar is built once per set of tabs and then updated in place, so a click is never lost to a poll.
function syncTabs(bar, ids, sel, content, pick, prefix = "tab-") {
  if (bar.dataset.ids !== ids.join("|")) {
    bar.dataset.ids = ids.join("|");
    fill(bar, ids.map((id) => h("button", { class: "rtab", role: "tab", "data-tab": id, "aria-controls": prefix + id, onclick: () => pick(id) })));
  }
  for (const b of bar.children) {
    const id = b.dataset.tab, on = id === sel, c = content(id), sig = JSON.stringify(c.sig);
    b.className = "rtab" + (on ? " on" : "") + (c.cls ? " " + c.cls : "");
    b.setAttribute("aria-selected", String(on));
    if (b.dataset.sig !== sig) { b.dataset.sig = sig; fill(b, c.kids); }
  }
}
function kidTabs(atGate) {
  const s = S.snap, res = {};
  (s.standing ? s.standing.hypotheses : []).forEach((r) => (res[r.code] = r));
  const met = s.hypotheses.filter((hy) => res[hy.code] && res[hy.code].status === "supported").length;
  const docs = phaseList(s).reduce((n, p) => n + p.steps.length + p.gates.length, 0);
  const avail = { now: true, checks: !!$("#kid-checks").firstChild, docs: docs > 0, activity: true, refusals: s.refusals.length > 0 };
  if (!avail[S.kidTab]) S.kidTab = "now";
  const needs = atGate && S.kidTab !== "now";
  const nowLabel = atGate ? "Your decision" : s.run.busy ? "Working" : isStopped(s) ? "Result: stopped" : isDone(s) ? "Result" : "Now";
  const count = { checks: s.hypotheses.length ? `${met}/${s.hypotheses.length} met` : "", docs: docs ? String(docs) : "",
    activity: String(s.trace.length), refusals: String(s.refusals.length) };
  syncTabs($("#kid-tabs"), KID_TABS.map(([id]) => id).filter((id) => avail[id]), S.kidTab, (id) => {
    if (id !== "now") return { sig: [count[id]], kids: [KID_TABS.find((t) => t[0] === id)[1], count[id] ? h("span", { class: "rt-n" }, count[id]) : null] };
    const icon = s.run.busy ? "busy" : atGate ? "gate" : "";
    return { cls: needs ? "needs" : "", sig: [nowLabel, icon, needs],
      kids: [icon === "busy" ? h("span", { class: "spin sm", "aria-hidden": "true" }) : icon === "gate" ? h("span", { class: "rt-dot", "aria-hidden": "true" }) : null,
        nowLabel, needs ? h("span", { class: "rt-flag" }, "Needs you") : null] };
  }, kidTabTo);
  for (const [id] of KID_TABS) $("#tab-" + id).hidden = id !== S.kidTab;
}
function kidTabTo(id) {
  S.kidTab = id;
  renderRun();
  // Keep the tab bar where it is: a long page scrolled down jumps back to the top of the chosen tab.
  const panel = $("#tab-" + id), bar = $("#kid-tabs");
  if (!panel || !bar) return;
  const y = panel.getBoundingClientRect().top + window.scrollY - bar.getBoundingClientRect().bottom - 8;
  if (window.scrollY > y) window.scrollTo({ top: y });
}

function docsSig(s) {
  return s.phases.map((p) => [p.n, p.status, p.steps.map((st) => [st.name, st.status_label, str(st.content).length, st.approved]),
    p.gates.map((g) => [g.name, g.outcome, g.override_reason])]);
}
function kidKey() {
  const s = S.snap, st = s.run.state, kind = pendingKind(s);
  return JSON.stringify([s.run.id, st, s.run.busy, s.run.error, s.step.can_retry, s.approvals.map((a) => [a.id, a.status]),
    s.overrides.length, s.build_unlocked.ok, s.spec.map((r) => r.dropped), s.pending, s.improver, kind,
    kind === "review_hypotheses" ? s.hypotheses : 0, kind === "confirm_brief" ? [s.brief, s.contract] : 0,
    kind === "experiment" ? [s.standing && s.standing.verdict, s.standing_error, s.traffic] : 0,
    kind || isStopped(s) || isDone(s) ? docsSig(s) : 0, isStopped(s) ? s.refusals.length : 0, S.kidOpen]);
}

function kidTop() {
  const s = S.snap, el = clear($("#kid-top"));
  const idea = s.run.idea || s.brief.idea;
  if (!idea) return;
  // One line by default; click to read the whole idea.
  const box = h("button", { class: "kid-idea", title: idea, "aria-expanded": "false",
    onclick: () => box.setAttribute("aria-expanded", String(box.classList.toggle("open"))) },
    h("span", { class: "kid-soft" }, s.run.product_name ? s.run.product_name : "Your idea"), h("span", { class: "idea-line" }, idea));
  add(el, box);
}

const KID_SCREENS = {
  confirm_brief: (c) => kidConfirmBrief(c), review_hypotheses: (c) => kidHypotheses(c), interview_notes: (c) => kidInterviews(c),
  choose_improvement: (c) => kidImprove(c), approve_landing: (c) => kidLanding(c), experiment: (c) => kidExperiment(c),
  review_spec: (c) => kidPlan(c), approve_product: (c) => kidProduct(c), approve_phase: (c) => kidApprovePhase(c),
};

function kidScreen(card) {
  const s = S.snap, kind = pendingKind(s);
  if (s.run.busy) return kidBusy(card);
  if (isStopped(s)) return kidStopped(card);
  if (isDone(s)) return kidDone(card);
  if (kind && KID_SCREENS[kind]) {
    if (s.run.error) add(card, h("div", { class: "kid-warn" }, s.run.error));
    return KID_SCREENS[kind](card);
  }
  if (kind) return kidUnknown(card, kind);
  return s.run.error || s.step.can_retry ? kidStuck(card) : kidBusy(card);
}
function kidMain() {
  const el = clear($("#kid-main"));
  const card = h("div", { class: "kid-card", "data-errhost": "" });
  el.append(card);
  try { kidScreen(card); } catch (e) {
    console.error(e);
    add(card, h("div", { class: "kid-warn" }, "This screen could not be shown. Try the expert view, or reload the page."));
  }
  // An error from the last action shows right above the pinned buttons, where the founder is looking.
  const err = h("div", { class: "kid-warn inline-err", role: "alert", hidden: true }), bar = card.querySelector(".kid-actions");
  if (bar) bar.prepend(err); else add(card, err);
}
// The pinned action bar at the bottom of a decision screen.
const kidActions = (...kids) => h("div", { class: "kid-actions" }, kids);

// The working screen updates in place on every poll: the latest steps, how long it has run, and when it last moved.
function kidDynamic() {
  const s = S.snap, last = $("#kid-last"), el = $("#kid-elapsed");
  if (last && last.dataset.n !== String(s.trace.length)) {
    last.dataset.n = String(s.trace.length);
    fill(last, s.trace.slice(-4).reverse().map((t, i) => h("li", { class: i ? null : "latest" }, h("span", { class: "ts" }, time(t.ts)),
      h("div", null, h("div", { class: "who" }, str(t.agent), h("span", { class: "act" }, " · " + str(t.action)))))));
  }
  if (el) {
    const founder = s.decisions.filter((d) => d.actor === "founder").pop();
    const since = new Date((founder && founder.ts) || s.run.created_at || Date.now()), t = s.trace[s.trace.length - 1];
    fill(el, `Working for ${fmtDur((Date.now() - since) / 1000)}`, t ? ` · last update ${fmtDur((Date.now() - new Date(t.ts)) / 1000)} ago` : "");
  }
}

function kidText(name, attrs) {
  S.kidText = S.kidText || {};
  const el = h("textarea", { class: "kid-input", rows: 2, ...attrs, oninput: (e) => (S.kidText[name] = e.target.value) });
  el.value = S.kidText[name] || "";
  return el;
}
function kidToggle(name) { S.kidOpen = S.kidOpen === name ? null : name; S.kidKey = null; S.nowKey = null; renderRun(); }
function kidHead(card, title, help) {
  const p = S.snap.pending || {};
  add(card, h("h2", null, p.title || title), (p.help || help) ? h("p", null, inline(p.help || help)) : null);
}

// ---- working / stuck
function kidBusy(card) {
  const s = S.snap, active = phaseList(s).find((p) => p.status === "active");
  add(card, h("div", { class: "kid-busy", role: "status" },
    h("div", { class: "busy-head" }, h("div", { class: "spin big", "aria-hidden": "true" }),
      h("div", null, active ? h("div", { class: "kid-soft" }, `Phase ${active.n} of 6 · ${active.name}`) : null, h("h2", null, s.step.label || "Working"),
        h("div", { class: "busy-meta", id: "kid-elapsed" }))),
    h("ol", { class: "act-list busy-feed", id: "kid-last", "aria-label": "Latest agent steps" }),
    h("p", { class: "kid-hint" }, "Nothing needs you right now. This can take a few minutes; you can leave this page open and come back. ",
      S.view === "simple" ? h("button", { class: "linkish", onclick: () => kidTabTo("activity") }, "See all activity") : null)));
}
function kidStuck(card) {
  const s = S.snap;
  add(card, h("div", { class: "kid-busy" },
    h("h2", null, "The run paused before finishing this step."),
    h("p", null, "This happens when a website or the model is slow. Trying again picks up where it stopped."),
    s.run.error ? h("details", { class: "kid-more" }, h("summary", null, "What went wrong"), h("div", { class: "kid-hint" }, s.run.error)) : null,
    h("button", { class: "kid-btn primary big", onclick: () => act("POST", runPath("/retry"), null, "Trying again.") }, "Try again")));
}
function kidUnknown(card, kind) {
  kidHead(card, humanName(kind), "This step needs you, but this screen does not know how to show it yet. Use the expert view.");
}

// ---- phase 1: confirm the brief
function briefDraftFrom(b) {
  const d = {};
  for (const [k] of BRIEF_FIELDS) { const v = b[k]; d[k] = Array.isArray(v) ? v.join(", ") : str(v); }
  return d;
}
function briefFromDraft(base, d) {
  const out = Object.assign({}, base);
  for (const [k, , type] of BRIEF_FIELDS) {
    const v = str(d[k]).trim();
    if (k === "skills" || k === "values") out[k] = v ? v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [];
    else if (type === "number") { const n = Number(v.replace(/[^\d.]/g, "")); out[k] = v && !Number.isNaN(n) ? n : null; }
    else out[k] = v;
  }
  if (!out.currency) out.currency = base.currency || "USD";
  return out;
}
function kidConfirmBrief(card) {
  const s = S.snap;
  if (!S.briefDraft || S.briefDraft._run !== s.run.id) S.briefDraft = Object.assign(briefDraftFrom(s.brief), { _run: s.run.id });
  const d = S.briefDraft;
  const sharp = stepBy(s, "sharpened_idea"), sd = obj((sharp && sharp.data && sharp.data.idea ? sharp.data : null) || (s.pending && s.pending.sharpened));
  const alt = stepBy(s, "alternatives"), ad = obj(alt && alt.data), opts = arr(ad.options).map(obj);
  const market = stepBy(s, "market");
  if (S.useSharp === undefined || S.useSharp === null) S.useSharp = !!sd.idea;
  kidHead(card, "Check your brief", "Your brief is now a contract. Code checks every later step against these limits. Fix anything that is wrong, then confirm.");

  if (sd.idea) {
    const choice = (use, title, idea, extra) => h("button", { class: "choice" + (S.useSharp === use ? " on" : ""), "aria-pressed": String(S.useSharp === use),
      onclick: () => { S.useSharp = use; S.kidKey = null; S.nowKey = null; renderRun(); } },
      h("span", { class: "eyebrow" }, title), h("span", { class: "choice-idea" }, inline(idea)), extra);
    add(card, h("h3", null, "Which version of the idea?"),
      h("div", { class: "choices" },
        choice(false, "Your original", s.brief.idea || s.run.idea || ""),
        choice(true, "Sharpened", sd.idea, [sd.customer ? h("span", { class: "small" }, h("b", null, "For: "), inline(sd.customer)) : null,
          arr(sd.changes).length ? h("ul", { class: "small" }, arr(sd.changes).map((c) => h("li", null, inline(typeof c === "string" ? c : JSON.stringify(c))))) : null])));
  }

  // Supporting detail, one row each; the limits open by themselves when one of them needs fixing.
  const fold = (key, title, meta, body, open) => {
    S.openDocs = S.openDocs || new Set();
    const isOpen = open || S.openDocs.has(key);
    return h("details", { class: "artdet", open: isOpen || null, ontoggle: (e) => (e.target.open ? S.openDocs.add(key) : S.openDocs.delete(key)) },
      h("summary", null, h("span", { class: "art-title" }, title), meta ? h("span", { class: "fold-meta" }, meta) : null), h("div", { class: "art-body" }, body));
  };
  const lim = s.contract.map(obj), bad = lim.filter((c) => c.status !== "ok" && c.status !== "unknown");
  const nClear = lim.filter((c) => c.status === "ok").length, nUnknown = lim.filter((c) => c.status === "unknown").length;
  const folds = h("div", { class: "folds" });
  if (lim.length) folds.append(fold("brief:limits", "Your hard limits",
    [`${nClear} clear`, nUnknown ? `${nUnknown} not given` : "", bad.length ? `${bad.length} to fix` : ""].filter(Boolean).join(" · "),
    h("div", { class: "slip" }, h("div", { class: "sec" }, lim.map((c) => lineItem(humanName(c.limit),
      Array.isArray(c.value) ? c.value.join(", ") || "none" : c.value === null || c.value === undefined || c.value === "" ? "not given" : str(c.value),
      c.status === "ok" ? "clear" : c.status === "unknown" ? "not given" : humanName(c.status).toLowerCase(), c.note))),
      h("div", { class: "sec small muted" }, "Code checks every later step against these limits.")), bad.length > 0));
  folds.append(fold("brief:edit", "Edit the brief", "fix a limit or the wording", h("div", { class: "brief-grid" }, BRIEF_FIELDS.map(([k, label]) => {
    const el = h("input", { class: "kid-input sm", type: "text", "aria-label": label, oninput: (e) => (d[k] = e.target.value) });
    el.value = d[k] || "";
    return h("label", { class: "kid-label sm" + (k === "idea" || k === "target_market" ? " wide" : "") }, label, el);
  }))));
  if (opts.length) {
    const cols = ["skills", "budget", "time", "values"];
    folds.append(fold("brief:alts", "How it compares with other directions", ad.recommended ? `recommended: ${str(ad.recommended)}` : `${opts.length} directions`, [
      h("p", { class: "kid-hint" }, "Each direction is scored against your skills, budget, time and values."),
      h("div", { class: "tablewrap" }, h("table", { class: "t" },
        h("thead", null, h("tr", null, h("th", null, "Direction"), cols.map((c) => h("th", null, humanName(c))), h("th", null, "Total"))),
        h("tbody", null, opts.map((o) => h("tr", { class: o.name === ad.recommended ? "recommended" : "" },
          h("td", null, inline(o.name), o.name === ad.recommended ? h("span", { class: "badge approved" }, "Recommended") : null),
          cols.map((c) => h("td", { class: "num" }, str(obj(o.fit)[c]))), h("td", { class: "num" }, h("b", null, str(o.total))))))))]));
  } else if (alt) folds.append(artifactDetails(Object.assign({}, alt, { title: "Other directions" })));
  if (market) folds.append(artifactDetails(Object.assign({}, market, { title: "Your market" })));
  add(card, folds);

  add(card, kidActions(h("button", { class: "kid-btn primary", onclick: () => {
    act("POST", runPath("/brief/confirm"), { brief: briefFromDraft(s.brief, d), use_sharpened: !!(sd.idea && S.useSharp) }, "Brief confirmed.")
      .then((r) => { if (r !== null) { S.briefDraft = null; S.useSharp = null; } });
  } }, "Confirm brief"), sd.idea ? h("span", { class: "kid-hint" }, S.useSharp ? "Goes on with the sharpened idea." : "Goes on with your original idea.") : null));
}

// ---- phase 1: pass marks
function kidHypotheses(card) {
  const s = S.snap, editing = S.kidOpen === "edit";
  if (!editing || !S.draft) { S.draft = s.hypotheses.map((x) => ({ ...x, critical: !!x.critical })); S.dirty = false; }
  const save = async () => {
    const r = await act("PUT", runPath("/hypotheses"), { hypotheses: S.draft }, "Saved.");
    if (r) { S.dirty = false; S.kidOpen = null; S.kidKey = null; renderRun(); }
    return r;
  };
  kidHead(card, "Set your pass marks", "For your idea to work, these things need to be true. Each has a pass mark: the evidence needed to call it met.");
  if (s.run && s.run.demo) add(card, h("div", { class: "kid-warn" }, h("b", null, "Demo mode: lenient pass marks. "),
    "Desk research counts and two entries are enough, so a showcase run can reach every phase. A real run drafts stricter ones."));
  add(card, h("div", { class: "kid-warn" }, h("b", null, "Once you lock these, they cannot be changed or lowered later. "),
      "A fingerprint of the exact set is saved and checked before every decision, so nobody can move the goalposts."),
    h("div", { class: editing ? "kid-list" : "checks-grid" }, (editing ? S.draft : s.hypotheses).map((hy, i) => h("div", { class: "kid-check" },
      h("div", { class: "kid-row" }, h("span", { class: "kid-num" }, String(i + 1)),
        hy.critical ? h("span", { class: "kid-pill must" }, "Must be met") : null,
        editing ? h("button", { class: "linkish kid-push", onclick: () => { S.draft.splice(i, 1); S.dirty = true; S.kidKey = null; renderRun(); } }, "Remove") : null),
      editing ? h("textarea", { class: "kid-input", rows: 2, oninput: (e) => { hy.statement = e.target.value; S.dirty = true; } }, str(hy.statement))
        : h("div", { class: "stmt" }, inline(hy.statement)),
      h("div", { class: "goal" }, plainGoal(hy)),
      !editing && hy.counted ? h("div", { class: "goal" }, "What is counted: " + hy.counted + ".") : null,
      hy.critical ? h("div", { class: "goal" }, "If this is not met, the run stops.") : null,
      !editing && hy.problems.length ? h("div", { class: "kid-warn" }, "Fix this one first: " + hy.problems.join("; ")) : null))),
    editing
      ? kidActions(h("button", { class: "kid-btn primary", onclick: save }, "Save changes"),
          h("button", { class: "kid-btn", onclick: () => { S.dirty = false; kidToggle("edit"); } }, "Cancel"))
      : kidActions(
          h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/hypotheses/approve"), null, "Locked. The search for evidence has started.") }, "Lock these pass marks"),
          h("button", { class: "kid-btn", onclick: () => kidToggle("edit") }, "Change the wording")));
}

// ---- phase 1: interviews
function kidInterviews(card) {
  const s = S.snap, kit = stepBy(s, "interview_kit");
  if (!S.notes || S.notes._run !== s.run.id) { S.notes = [{ who: "", quote: "" }]; S.notes._run = s.run.id; }
  const notes = S.notes;
  kidHead(card, "Talk to real people", "Before building, talk to a few people who have this problem. Ask about what they did in the past, not about your idea.");
  const web = s.ledger.filter((e) => e.source_kind === "hn" || e.source_kind === "web");
  if (!web.some((e) => arr(e.counts_for).length)) add(card, h("div", { class: "kid-note" },
    h("b", null, web.length ? "Nothing from public forums counts yet. " : "No public evidence found. "),
    web.length ? `None of the ${web.length} quotes found meets your pass marks, so your interview notes are what can count now.`
      : "Nobody online described this problem first-hand, so your interview notes are what can count now."));
  add(card, h("div", { class: "kid-note" }, h("b", null, "The system never invents interviews. "), "Only notes you type here are used, and they are marked as entered by you. Write what people did, paid or lost. A note that only says someone would use it, or liked the idea, counts at the weakest tier."),
    kit ? artifactDetails(kit) : null,
    h("h3", null, "Your notes"),
    h("div", { class: "kid-list" }, notes.map((n, i) => h("div", { class: "note-row" },
      h("label", { class: "kid-label sm" }, "Who (for example: freelance designer, Cairo)",
        h("input", { class: "kid-input sm", type: "text", value: n.who, oninput: (e) => (n.who = e.target.value) })),
      h("label", { class: "kid-label sm" }, "What they said, in their words",
        h("textarea", { class: "kid-input", rows: 2, oninput: (e) => (n.quote = e.target.value) }, n.quote)),
      notes.length > 1 ? h("button", { class: "linkish", onclick: () => { notes.splice(i, 1); S.kidKey = null; S.nowKey = null; renderRun(); } }, "Remove this note") : null))),
    h("button", { class: "linkish", onclick: () => { notes.push({ who: "", quote: "" }); S.kidKey = null; S.nowKey = null; renderRun(); } }, "Add another note"),
    kidActions(
      h("button", { class: "kid-btn primary", onclick: () => {
        const real = notes.filter((n) => str(n.who).trim() && str(n.quote).trim()).map((n) => ({ who: n.who.trim(), quote: n.quote.trim() }));
        if (!real.length) { inlineErr("Add at least one note with who said it and what they said, or choose that you have not done interviews yet."); return; }
        act("POST", runPath("/interviews"), { notes: real, skipped: false }, "Notes saved.").then((r) => { if (r !== null) S.notes = null; });
      } }, "Save notes and continue"),
      h("button", { class: "kid-btn", onclick: () => act("POST", runPath("/interviews"), { notes: [], skipped: true }, "Noted. The run continues without interviews.") }, "Skip: I have not done interviews yet"),
      h("p", { class: "kid-hint wide" }, "Skipping is fine. The evidence gate then judges only the evidence already collected.")));
}

// ---- after a failed gate: improvement options
function citeLinks(cites) {
  const s = S.snap;
  return arr(cites).map((c) => {
    const e = s.ledger.find((x) => x.code === c), url = e && safeHref(e.source_url);
    return url ? h("a", { class: "cite", href: url, target: "_blank", rel: "noopener noreferrer", title: str(e.quote || e.claim) }, `${c}, ${hostOf(url)}`)
      : h("span", { class: "cite" }, str(c));
  });
}
function kidImprove(card) {
  const s = S.snap, imp = obj(s.improver), opts = arr(imp.options).map(obj);
  let failed = imp.failed_gate;
  if (failed && typeof failed !== "object") failed = allGates(s).filter((g) => g.name === failed).pop() || { name: failed };
  kidHead(card, "The gate did not pass", "Here are changed versions of the idea. Whichever you pick is tested again against the same pass marks. They cannot be lowered, and the original result stays on record.");
  if (failed) add(card, gateSummary(failed));
  add(card, h("div", { class: "kid-row spread" }, h("h3", null, "Pick a changed idea to test"),
    imp.round ? h("span", { class: "kid-soft" }, `Improvement round ${imp.round} of ${imp.max_rounds || 2}`) : null));
  add(card, h("div", { class: "kid-options" }, opts.map((o) => h("div", { class: "kid-option" + (imp.chosen === o.id ? " chosen" : "") },
    h("div", { class: "kid-row spread opt-head" }, h("h3", null, `Option ${str(o.id)}`),
      h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/improve"), { option_id: o.id }, `Testing option ${o.id}.`) }, `Try option ${str(o.id)}`)),
    h("div", { class: "stmt" }, inline(o.idea)),
    o.change ? h("div", { class: "small" }, h("b", null, "What changed: "), inline(o.change)) : null,
    o.assumption || !arr(o.cites).length ? h("div", { class: "small" }, h("mark", { class: "assume" }, "ASSUMPTION"), " Not backed by collected evidence.") : null,
    o.customer || o.why || arr(o.cites).length ? h("details", { class: "kid-more small" }, h("summary", null, "Who it is for, why, and the evidence"),
      o.customer ? h("div", null, h("b", null, "For: "), inline(o.customer)) : null,
      o.why ? h("div", null, h("b", null, "Why: "), inline(o.why)) : null,
      arr(o.cites).length ? h("div", { class: "cites" }, h("b", null, "Evidence: "), citeLinks(o.cites)) : null) : null))));
  const over = S.kidOpen === "impover";
  add(card, h("div", { class: "kid-alt" },
    h("span", { class: "kid-soft" }, "Or decide yourself:"),
    h("button", { class: "kid-btn stop", onclick: () => act("POST", runPath("/improve"), { option_id: "stop" }, "Stopped.") }, "Stop here"),
    h("button", { class: "kid-btn" + (over ? " on" : ""), "aria-expanded": String(over), onclick: () => kidToggle("impover") }, over ? "Cancel the override" : "Go on anyway…"),
    h("p", { class: "kid-hint wide" }, "Stopping is a valid result: the stop, its reasons and what would change it are kept. Going on anyway needs a written reason, kept for good beside the result.")),
    over ? h("div", { class: "kid-form" }, kidText("impover", { rows: 3, placeholder: "Why go on without the evidence? (a full sentence)" }),
      h("div", { class: "kid-row" }, h("button", { class: "kid-btn primary", onclick: () => {
        const reason = str(S.kidText.impover).trim();
        if (reason.length < 30) { inlineErr("Write a full sentence about why (at least 30 characters)."); return; }
        act("POST", runPath("/improve"), { option_id: "override", reason }, "Override saved.").then((r) => { if (r) { S.kidText.impover = ""; S.kidOpen = null; } });
      } }, "Save override and go on"))) : null);
}

// ---- phase 2: test page and demand
function kidApprovalRow(card, kind, yesLabel) {
  const s = S.snap, a = s.approvals.find((x) => x.kind === kind && x.status === "pending");
  if (!a) return;
  const open = S.kidOpen === "changes";
  const note = open ? kidText("changes", { placeholder: "What should change? For example: make it shorter, change the price." }) : null;
  add(card, kidActions(
    open ? h("div", { class: "kid-form wide" }, note, h("div", { class: "kid-row" }, h("button", { class: "kid-btn", onclick: async () => {
      const r = await act("POST", runPath(`/approvals/${a.id}`), { approve: false, note: note.value }, "Sent back. A new draft is on its way.");
      if (r) { S.kidText.changes = ""; S.kidOpen = null; S.kidKey = null; renderRun(); }
    } }, "Send back"))) : null,
    h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath(`/approvals/${a.id}`), { approve: true }, "Approved.") }, yesLabel),
    h("button", { class: "kid-btn", onclick: () => kidToggle("changes") }, open ? "Cancel" : "Send back with a note")));
}
function kidLanding(card) {
  const s = S.snap, counting = s.ledger.filter((e) => e.counts_for.length).length;
  kidHead(card, "Your test page is ready", "This page tells people what you plan to make and lets them register interest. Nobody pays anything.");
  add(card, h("div", { class: "mocknote mocked" }, h("b", null, "MOCKED: "), "public publishing. Approving puts the page online on this computer only."),
    h("p", { class: "kid-hint" }, `So far ${s.ledger.length} pieces of evidence were found and ${counting} count towards your pass marks.`),
    s.run.slug ? frameBox(`/p/${s.run.slug}?preview=1`, "kid-frame", "Test page preview") : null);
  kidApprovalRow(card, "publish_landing", "Approve the page");
}
function realTraffic(s) {
  const real = s.traffic.filter((t) => !t.excluded), own = s.traffic.filter((t) => t.excluded);
  const sum = (xs, k) => xs.reduce((n, t) => n + (Number(t[k]) || 0), 0);
  return { visitors: sum(real, "visitors"), regs: sum(real, "commitments"), own: sum(own, "visitors") };
}
function kidExperiment(card) {
  const s = S.snap, v = obj(s.standing), key = s.standing_error ? "refused" : v.verdict;
  const t = realTraffic(s), demand = allGates(s).filter((g) => g.name === "demand").pop();
  kidHead(card, "Demand test", "Your test page is running on this computer. Show it to real people and ask them to look. Only real visits and real registrations count.");
  add(card, h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", null, String(t.visitors)), h("span", null, "real visitors")),
      h("div", { class: "stat" }, h("b", null, String(t.regs)), h("span", null, "registrations of interest")),
      h("div", { class: "stat muted" }, h("b", null, String(t.own)), h("span", null, "your own visits, not counted"))),
    h("p", { class: "kid-hint" }, "Every counted visit is a real person. Your own visits from this browser are marked as yours and never count. With no real visitors, the result is \"not enough evidence\"."),
    s.run.slug ? h("div", { class: "kid-row" }, h("a", { class: "kid-btn", href: `/p/${s.run.slug}`, target: "_blank", rel: "noopener" }, "Open the test page"),
      h("span", { class: "kid-hint" }, "The page only works on this computer for now.")) : null);
  if (demand) add(card, gateSummary(demand));
  else if (key) add(card, h("div", { class: "kid-answer " + key }, h("div", null, h("div", { class: "kid-soft" }, "Current standing, computed by code"),
    h("h3", null, (OUTCOME_WORD[KID_VERDICT_WORD[key]] || "") + (key === "insufficient_evidence" ? ": not enough evidence" : "")), h("p", null, (KID_ANSWER[key] || [""])[0]))));
  if (s.standing_error) add(card, h("div", { class: "kid-warn" }, s.standing_error));
  const main = [h("button", { class: "kid-btn" + (s.build_unlocked.ok ? "" : " primary"), onclick: () => act("POST", runPath("/verdict"), null, "Result worked out and recorded.") }, "Work out the result now"),
    s.build_unlocked.ok ? h("button", { class: "kid-btn go", onclick: () => act("POST", runPath("/proceed"), null, "On to the build.") }, "Continue to build") : null];
  if (s.build_unlocked.ok) { add(card, kidActions(main)); return; }
  const open = S.kidOpen;
  const submit = (value, name, msg) => async (e) => {
    const btn = e.currentTarget, reason = str(S.kidText[name]).trim();
    if (reason.length < 30) { inlineErr("Write a full sentence about why (at least 30 characters)."); return; }
    btn.disabled = true;
    const r = await act("POST", runPath("/override"), { value, reason }, msg);
    btn.disabled = false;
    if (!r) return;
    S.kidText[name] = ""; S.kidOpen = null;
    if (value === "go") await act("POST", runPath("/proceed"), null, "On to the build.");
  };
  // Overriding is the exception, so it is a quiet row; the written reason opens only when chosen.
  const form = open === "anyway" ? ["anyway", "Why go on without the evidence? (a full sentence)", "go", "Save override and go on", "Override saved."]
    : open === "stop" ? ["stop", "Why are you stopping? (a full sentence)", "kill", "Stop this idea", "Stopped."] : null;
  add(card, h("div", { class: "kid-alt" }, h("span", { class: "kid-soft" }, "Or decide yourself:"),
      h("button", { class: "kid-btn stop", "aria-expanded": String(open === "anyway"), onclick: () => kidToggle("anyway") }, open === "anyway" ? "Cancel" : "Go on anyway…"),
      h("button", { class: "kid-btn stop", "aria-expanded": String(open === "stop"), onclick: () => kidToggle("stop") }, open === "stop" ? "Cancel" : "Stop this idea…"),
      h("p", { class: "kid-hint wide" }, "Either needs a written reason, saved for good beside the result. Stopping a weak idea early saves time and money for a better one.")),
    form ? h("div", { class: "kid-form" }, kidText(form[0], { rows: 3, placeholder: form[1] }),
      h("div", { class: "kid-row" }, h("button", { class: "kid-btn stop", onclick: submit(form[2], form[0], form[4]) }, form[3]))) : null,
    kidActions(main));
}

// ---- phase 3: plan and product
function kidPlan(card) {
  const s = S.snap, acc = s.spec.filter((r) => r.accepted), rej = s.spec.filter((r) => !r.accepted);
  kidHead(card, "The plan for your product", "Every part is here because real evidence supports it. Untick anything you do not want.");
  add(card, h("div", { class: "kid-list" }, acc.map((r) => h("label", { class: "kid-planrow" + (r.dropped ? " off" : "") },
      h("input", { type: "checkbox", checked: !r.dropped, onchange: (e) => act("POST", runPath(`/spec/${r.code}`), { dropped: !e.target.checked }) }),
      h("span", { class: "kid-plantext" }, inline(r.text)),
      h("span", { class: "kid-pill " + r.priority }, KID_PRIORITY[r.priority] || str(r.priority))))),
    rej.length ? h("p", { class: "kid-hint" }, `${rej.length} ${rej.length === 1 ? "idea was" : "ideas were"} left out because no checked evidence supports ${rej.length === 1 ? "it" : "them"}.`) : null,
    acc.some((r) => !r.dropped)
      ? kidActions(h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/spec/approve"), null, "Plan approved. Building now.") }, "Approve the plan"),
          h("span", { class: "kid-hint" }, `${acc.filter((r) => !r.dropped).length} of ${acc.length} parts will be built.`))
      : kidSpecDeadEnd(rej));
}
// No part of the plan has checked evidence: stop, or build it anyway as ASSUMPTIONS with a written reason.
function kidSpecDeadEnd(rej) {
  const buildable = rej.filter((r) => !arr(r.unsupported).length && !r.dropped);
  return h("div", null,
    h("p", { class: "kid-hint" }, "No part of the plan has checked evidence behind it. You can stop here, or build it anyway as a guess (ASSUMPTION): write why, and the system keeps its own verdict next to your reason."),
    buildable.length ? kidText("assume", { rows: 3, placeholder: "Why build it anyway? (a full sentence, at least 30 characters)" }) : null,
    kidActions(
      buildable.length ? h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/spec/assume"), { reason: str(S.kidText.assume).trim() }, "Building it as an ASSUMPTION.") }, "Build it as an ASSUMPTION") : null,
      h("button", { class: "kid-btn stop", onclick: () => act("POST", runPath("/spec/stop"), { reason: str(S.kidText.assume || "").trim() }, "Stopped.") }, "Stop here")));
}
function kidProduct(card) {
  const s = S.snap;
  kidHead(card, "Your product is ready to try", "Try it below. When you are happy, approve it.");
  add(card, s.run.slug ? frameBox(`/app/${s.run.slug}?preview=1`, "kid-frame", "Product preview") : null);
  const guide = stepBy(s, "user_guide"), tests = stepBy(s, "test_report");
  if (tests || guide) add(card, h("div", { class: "folds" }, tests ? artifactDetails(tests) : null, guide ? artifactDetails(guide) : null));
  kidApprovalRow(card, "publish_product", "Approve the product");
}

// ---- phases 4 to 6: approve or send back
const PHASE_HELP = {
  4: "Draft price and policies. They are drafts, not legal advice. Nothing is signed or published until you approve.",
  5: "Your store page and launch posts. Public listing and posting are MOCKED: nothing is posted anywhere. Orders and payments in the sale-to-delivery test are MOCKED; no money moves.",
  6: "Support reply drafts, your numbers and a memo on whether to keep going, change direction or stop. Sending replies is MOCKED.",
};
function kidApprovePhase(card) {
  const s = S.snap, n = pendingPhase(s) || 4, phase = phaseList(s)[n - 1] || { name: "", steps: [], gates: [] };
  kidHead(card, `Approve phase ${n}: ${phase.name}`, PHASE_HELP[n] || "Read each document, then approve or send it back with a note.");
  // The phase's documents in one viewer: pick on the left, read on the right.
  const items = phaseItems(Object.assign({}, phase, { n, gates: phase.gates.filter((g) => g.outcome) }));
  const open = S.kidOpen === "sendback", decisions = arr(s.pending && s.pending.decisions);
  S.docSel = S.docSel || {};
  const memo = decisions.length ? items.find((it) => /:memo$/.test(it.key)) : null;  // the final decision opens on the memo
  if (memo && !S.docSel[`approve-${n}`]) S.docSel[`approve-${n}`] = memo.key;
  add(card, items.length ? docViewer(`approve-${n}`, items) : h("div", { class: "empty" }, "No documents in this phase yet."));
  const DEC = { persevere: ["Keep going", "primary"], pivot: ["Change direction", ""], stop: ["Stop here", "stop"] };
  const blocked = str(s.pending && s.pending.blocked);
  if (decisions.length) add(card, h("div", { class: "kid-form" }, h("h3", null, "Your decision"),
    h("p", { class: "kid-hint" }, "Read the memo, then choose. The choice is recorded as the final gate. Keeping going against the memo's recommendation is an override: write why (a full sentence, at least 30 characters)."),
    kidText("decide", { rows: 2, placeholder: "Why? (required to keep going against the memo's recommendation)" })));
  add(card, kidActions(
    blocked ? h("p", { class: "kid-hint wide" }, blocked) : null,
    open ? h("div", { class: "kid-form wide" }, kidText("sendback", { rows: 3, placeholder: "What should change?" }),
      h("div", { class: "kid-row" }, h("button", { class: "kid-btn", onclick: async () => {
        const note = str(S.kidText.sendback).trim();
        if (!note) { inlineErr("Write what should change."); return; }
        const r = await act("POST", runPath("/gate"), { phase: n, action: "reject", note }, "Sent back. A new draft is on its way.");
        if (r) { S.kidText.sendback = ""; S.kidOpen = null; S.kidKey = null; renderRun(); }
      } }, "Send back"))) : null,
    blocked ? h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/gate"),
      { phase: n, action: "reject", note: "Run the delivery tests again." }, "Running the delivery tests again.") }, "Run the delivery tests again")
    : decisions.length ? decisions.map((dname) => h("button", { class: "kid-btn " + ((DEC[dname] || [])[1] || ""), onclick: () => act("POST", runPath("/gate"),
      { phase: n, action: "approve", note: str(S.kidText.decide || S.kidText.sendback).trim(), decision: dname }, "Decision recorded.") }, (DEC[dname] || [humanName(dname)])[0]))
    : h("button", { class: "kid-btn primary", onclick: () => act("POST", runPath("/gate"), { phase: n, action: "approve", note: "" }, `Phase ${n} approved.`) }, `Approve phase ${n}`),
    h("button", { class: "kid-btn", onclick: () => kidToggle("sendback") }, open ? "Cancel" : "Send back with a note")));
}

// ---- endings
function kidStopped(card) {
  const s = S.snap, gate = lastStopGate(s), ov = s.overrides.filter((x) => x.kind === "verdict").pop();
  const intake = s.refusals.find((r) => r.where === "intake" || r.where === "brief") || (gate && gate.name === "intake" ? s.refusals[0] : null);
  const fromSteps = allSteps(s).map((st) => obj(st.data).allowed_alternatives).find((x) => arr(x).length);
  const alts = arr(s.allowed_alternatives || fromSteps || (s.pending && s.pending.alternatives)).map((a) => (typeof a === "string" ? a : str(obj(a).name || obj(a).idea)));
  add(card, h("div", { class: "end-head" },
    h("div", null, h("h2", null, "The run stopped here"),
      h("p", { class: "kid-hint" }, "A stop is a result, not a failure. The evidence or the rules do not support going further right now. Read why below, then start a new brief or export the record.")),
    gate ? null : verdictBig("stop")),
    h("div", { class: "kid-row" },
      h("button", { class: "kid-btn primary", onclick: () => (location.hash = "#/") }, "Start with a new brief"),
      h("button", { class: "kid-btn", onclick: exportOutputs }, "Export outputs")));
  if (gate) add(card, gateCard(gate));
  if (!gate && s.run.stop_reason) add(card, h("p", null, h("b", null, "Why: "), inline(s.run.stop_reason)));
  if (!gate && ov) add(card, h("div", { class: "override" }, h("div", { class: "k" }, "Stopped by you"), h("div", null, `“${str(ov.reason)}”`)));
  if (intake) add(card, refusalCard(intake));
  if (alts.length) add(card, h("h3", null, "Directions that fit the rules"), h("ul", null, alts.map((a) => h("li", null, inline(a)))));
  const imp = s.improver;
  if (imp && arr(imp.options).length) add(card, h("p", { class: "kid-hint" }, `The idea improver ran ${imp.round || 1} of ${imp.max_rounds || 2} rounds. Every earlier result stays on record under Documents.`));
}
// The finished screen leads with the memo's recommendation and any founder override of it.
const REC_OUTCOME = { persevere: "go", pivot: "pivot", stop: "stop" };
function kidDone(card) {
  const s = S.snap, memo = stepBy(s, "memo"), slug = s.run.slug;
  const d = obj(memo && memo.data), rec = str(d.recommendation).toLowerCase(), c = obj(d.counts);
  const decision = allGates(s).filter((g) => g.name === "decision").pop();
  const overridden = allGates(s).filter((g) => g.override_reason).length;
  const verdict = str(d.verdict) === "insufficient" ? "not enough evidence" : str(d.verdict).replace(/_/g, " ");
  add(card, h("div", { class: "eyebrow" }, "All six phases ran"),
    h("div", { class: "done-head" }, h("h2", null, rec ? `The memo recommends: ${rec}` : "The run is finished"), rec ? verdictBig(REC_OUTCOME[rec] || "") : null),
    d.verdict ? h("p", null, `Verdict by code: ${verdict}. ${fmtInt(c.visits)} real visits, ${fmtInt(c.reserves)} register-interest clicks.`) : null,
    decision && decision.override_reason && decision.outcome !== REC_OUTCOME[rec] ? h("div", { class: "override" },
      h("div", { class: "k" }, "You chose to go on anyway"), h("div", null, `“${str(decision.override_reason)}”`)) : null,
    h("div", { class: "kid-row" },
      slug ? h("a", { class: "kid-btn primary", href: `/app/${slug}`, target: "_blank", rel: "noopener" }, "Open the product") : null,
      slug ? h("a", { class: "kid-btn", href: `/store/${slug}`, target: "_blank", rel: "noopener" }, "Open the store page (MOCKED)") : null,
      h("button", { class: "kid-btn", onclick: exportOutputs }, "Export outputs")),
    overridden ? h("p", { class: "kid-hint" }, "Gates you overrode are marked “Your override” under Documents.") : null,
    memo ? artifactDetails(Object.assign({}, memo, { title: "Read the full memo" })) : null);
}

// ---- all documents and decisions, by phase
// One phase at a time, one document at a time; it follows the newest phase until the founder picks one.
function kidDocs() {
  const s = S.snap, el = $("#kid-docs");
  const phases = phaseList(s).filter((p) => p.steps.length || p.gates.length);
  const old = el.querySelector(".dv-pane"), keep = old && el.dataset.ph === String(S.docPhase) ? old.scrollTop : 0;
  clear(el);
  if (!phases.length) return;
  if (!S.docPicked || !phases.some((p) => p.n === S.docPhase)) S.docPhase = phases[phases.length - 1].n;
  const p = phases.find((x) => x.n === S.docPhase);
  el.dataset.ph = String(p.n);
  el.append(h("div", { class: "kid-card docs-card" },
    h("div", { class: "seg", role: "tablist", "aria-label": "Phases" }, phases.map((x) => h("button", { class: "seg-btn" + (x.n === p.n ? " on" : ""), role: "tab",
      "aria-selected": String(x.n === p.n), onclick: () => { S.docPhase = x.n; S.docPicked = true; renderRun(); } },
      `${x.n}. ${x.name}`, h("span", { class: "rt-n" }, String(x.steps.length + x.gates.length))))),
    docViewer("docs-" + p.n, phaseItems(p))));
  const pane = el.querySelector(".dv-pane");
  if (pane && keep) pane.scrollTop = keep;
}

function kidActivity() {
  const s = S.snap, v = S.actView || "trace";
  let box = $("#act-box");
  if (!box) {
    box = h("div", { class: "act-box", id: "act-box", tabindex: "0" });
    fill($("#kid-activity"), h("div", { class: "kid-card" },
      h("div", { class: "kid-row spread" }, h("div", null, h("h3", null, "Activity"), h("p", { class: "kid-hint" }, "Newest first. Every model call, search, gate and decision, as it happens.")),
        h("div", { class: "seg", id: "act-seg" }, [["trace", "Agent steps"], ["decisions", "Decisions"]].map(([id]) =>
          h("button", { class: "seg-btn", "data-v": id, onclick: () => { S.actView = id; renderRun(); } })))),
      box));
  }
  for (const b of $("#act-seg").children) {
    const id = b.dataset.v, on = id === v;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    fill(b, id === "decisions" ? "Decisions" : "Agent steps", h("span", { class: "rt-n" }, String((id === "decisions" ? s.decisions : s.trace).length)));
  }
  fill(box, activityList(s, v, 250));
}

// ---- the pass-marks board (after locking)
function kidChecks() {
  const s = S.snap, el = clear($("#kid-checks"));
  if (!s.run.lock_hash || !s.hypotheses.length || pendingKind(s) === "review_hypotheses") return;
  const res = {}; (s.standing ? s.standing.hypotheses : []).forEach((r) => (res[r.code] = r));
  el.append(h("div", { class: "kid-card" }, h("div", null, h("h3", null, "Your pass marks"),
    h("p", { class: "kid-hint" }, "Locked and cannot be lowered. Open one to see the evidence behind it.")),
    h("div", { class: "checks-grid" }, s.hypotheses.map((hy, i) => {
      const r = res[hy.code], status = r ? r.status : "draft", [icon, label] = KID_STATUS[status] || KID_STATUS.draft;
      const have = r ? Number(r.sample) || 0 : 0, need = Number(hy.min_sample) || 1, reserve = kidRESERVE.has(hy.metric);
      const pct = Math.min(100, Math.round((have / Math.max(1, need * 1.25)) * 100));
      const proof = r ? arr(r.counted).map((c) => s.ledger.find((e) => e.code === c)).filter(Boolean) : [];
      return h("details", { class: "kid-check " + status },
        h("summary", null,
          h("div", { class: "kid-row" }, h("span", { class: "kid-num" }, String(i + 1)),
            h("span", { class: "kid-pill " + status }, `${icon}${label}`),
            hy.critical ? h("span", { class: "kid-pill must" }, "Must be met") : null),
          h("div", { class: "stmt" }, inline(hy.statement)),
          h("div", { class: "kid-bar", role: "img", "aria-label": `${have} of ${need} needed` }, h("span", { style: `width:${pct}%` }), h("i", { style: "left:80%", title: "Pass mark" })),
          h("div", { class: "goal" }, have >= need ? `${have} ${reserve ? "real visitors" : "pieces of evidence"} (needed ${need})`
              : reserve ? `${have} of ${need} real visitors so far` : `${have} of ${need} pieces of evidence found`,
            status === "insufficient" && !reserve ? ". " + plainGoal(hy) : "")),
        h("div", { class: "kid-proofs" }, proof.length ? proof.slice(0, 6).map((e) => {
          const url = safeHref(e.source_url);
          return h("div", { class: "kid-proof" + (e.stance === "refutes" ? " against" : "") },
            h("div", { class: "kid-soft" }, e.stance === "refutes" ? "Against" : "For"),
            e.quote ? h("blockquote", null, `“${e.quote}”`) : h("div", null, inline(e.claim)),
            url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, hostOf(url))
              : h("span", { class: "kid-soft" }, e.source_kind === "landing" || e.source_kind === "product" ? "A real visitor registered on your page" : e.source_kind === "interview" ? (e.verification === "simulated_demo" ? "MOCKED: simulated in demo mode, not a real person" : "From your interview notes") : ""));
        }) : h("div", { class: "kid-hint" }, "No evidence counts for this pass mark yet."),
          proof.length > 6 ? h("div", { class: "kid-hint" }, `And ${proof.length - 6} more in the expert view.`) : null,
          r && arr(r.excluded).length ? h("div", { class: "kid-hint" }, kidLeftOut(r.excluded)) : null));
    }))));
}

function kidWhyOut(reason) {
  const x = str(reason).toLowerCase();
  if (x.includes("minimum tier")) return "not strong enough for this pass mark";
  if (x.startsWith("unverified")) return "the quoted words were not found on the page";
  if (x.startsWith("skeptic")) return "the skeptic showed it does not prove this";
  if (x.startsWith("llm opinion")) return "only a model's opinion";
  if (x.includes("traffic")) return "your own visits";
  return "does not count";
}
function kidLeftOut(excluded) {
  const groups = {};
  arr(excluded).forEach((x) => { const k = kidWhyOut(x.reason); groups[k] = (groups[k] || 0) + 1; });
  const n = arr(excluded).length;
  return `${n} more ${n === 1 ? "piece" : "pieces"} of evidence did not count: ` + Object.entries(groups).map(([k, c]) => `${c} ${k}`).join(", ") + ".";
}
