"use strict";
/* Shared pieces for both views: snapshot defaults, a safe markdown renderer, artifact viewer,
   gate result card, phase strip, refusal receipts, "ask for a change", cost footer, export,
   founder brief form and the recorded-run viewer. Model and web text only ever becomes
   text nodes through h(); HTML artifacts go into a sandboxed iframe via srcdoc. */

const PHASE_NAMES = ["Discover", "Validate", "Build", "Commercial setup", "Sell, deliver and get paid", "Operate and learn"];
const OUTCOME_WORD = { go: "Go", repeat: "Repeat", pivot: "Pivot", stop: "Stop" };
const OUTCOME_LINE = {
  go: "Passed. The run can move on.",
  repeat: "Not yet. This step runs again.",
  pivot: "Change direction. The idea needs to change before going on.",
  stop: "Stop. The evidence does not support going on.",
};
const GATE_TYPE_LABEL = { founder_approval: "Your approval", evidence_threshold: "Evidence against pass marks", tests: "Automatic tests" };
const STATE_KINDS = new Set(["confirm_brief", "review_hypotheses", "interview_notes", "choose_improvement", "approve_landing",
  "experiment", "review_spec", "approve_product"]);
const STOP_STATES = new Set(["stopped", "killed"]);
const DONE_STATES = new Set(["done", "live"]);

const arr = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const str = (x) => (x === null || x === undefined ? "" : String(x));
const humanName = (x) => str(x).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const safeHref = (u) => { const s = str(u).trim(); return /^https?:\/\//i.test(s) || /^\/(?!\/)/.test(s) ? s : null; };
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch (_) { return str(u); } };
const fmtInt = (n) => { const v = Number(n) || 0; return v.toLocaleString("en-US"); };

// ------------------------------------------------------------ snapshot defaults
function normalizeSnap(s) {
  s = obj(s);
  s.run = Object.assign({ id: S.runId, state: "", busy: false, idea: "", slug: "", error: null, lock_hash: null }, obj(s.run));
  for (const k of ["hypotheses", "ledger", "approvals", "overrides", "spec", "traffic", "trace", "decisions", "stages",
    "phases", "refusals", "contract", "decision_rule"]) s[k] = arr(s[k]);
  s.step = Object.assign({ label: "", auto: false, can_retry: false, graph_next: [] }, obj(s.step));
  s.step.graph_next = arr(s.step.graph_next);
  s.gaps = Object.assign({ open: [], rounds: 0, cap: 0 }, obj(s.gaps));
  s.model_calls = Object.assign({ count: 0, failed: 0, seconds: 0, cost_usd: 0, tool_calls: 0 }, obj(s.model_calls));
  s.build_unlocked = Object.assign({ ok: false, reason: "" }, obj(s.build_unlocked));
  s.cost = Object.assign({ usd: 0, tokens_in: 0, tokens_out: 0, calls: 0, models: [] }, obj(s.cost));
  s.cost.models = arr(s.cost.models);
  s.brief = obj(s.brief);
  if (!s.pending || typeof s.pending !== "object") s.pending = null;
  if (!s.improver || typeof s.improver !== "object") s.improver = null;
  s.phases = s.phases.map((p) => {
    p = obj(p);
    return Object.assign({}, p, { steps: arr(p.steps).map(obj), gates: arr(p.gates).map(obj) });
  });
  for (const hy of s.hypotheses) hy.problems = arr(hy.problems);
  for (const e of s.ledger) { e.counts_for = arr(e.counts_for); e.excluded_for = arr(e.excluded_for); e.hypothesis_codes = arr(e.hypothesis_codes); }
  if (s.standing && typeof s.standing === "object") s.standing.hypotheses = arr(s.standing.hypotheses);
  return s;
}

function pendingKind(s) {
  if (s.pending && s.pending.kind) return s.pending.kind;
  const st = s.run.state;
  if (/^approve_phase\d$/.test(st)) return "approve_phase";
  return STATE_KINDS.has(st) ? st : null;
}
function pendingPhase(s) {
  if (s.pending && s.pending.phase) return Number(s.pending.phase);
  const m = /^approve_phase(\d)$/.exec(s.run.state);
  return m ? Number(m[1]) : null;
}
const isStopped = (s) => STOP_STATES.has(s.run.state);
const isDone = (s) => DONE_STATES.has(s.run.state);

function allSteps(s) { return s.phases.flatMap((p) => p.steps.map((st) => Object.assign({ phase: p.n }, st))); }
function stepBy(s, name) { const all = allSteps(s).filter((x) => x.name === name); return all[all.length - 1] || null; }
function allGates(s) { return s.phases.flatMap((p) => p.gates.map((g) => Object.assign({ phase: p.n }, g))); }
// Repeated gates of one phase read "1 of 3 · 23:10", so each run of a gate can be told apart.
function gateNth(gates) {
  const list = arr(gates).map(obj), total = {}, seen = {};
  list.forEach((g) => (total[g.name] = (total[g.name] || 0) + 1));
  return list.map((g) => {
    seen[g.name] = (seen[g.name] || 0) + 1;
    return total[g.name] > 1 ? `${seen[g.name]} of ${total[g.name]}${g.at ? " · " + time(g.at).slice(0, 5) : ""}` : "";
  });
}
function lastStopGate(s) { const g = allGates(s).filter((x) => x.outcome === "stop"); return g[g.length - 1] || null; }

// The six phases, from the snapshot when present, otherwise guessed from the older run states.
function phaseList(s) {
  if (s.phases.length) {
    return PHASE_NAMES.map((name, i) => Object.assign({ n: i + 1, name, status: "pending", steps: [], gates: [] },
      s.phases.find((p) => Number(p.n) === i + 1) || {}));
  }
  const st = s.run.state;
  const now = /hypoth|gather|verify|skeptic|gaps/.test(st) ? 1 : /landing|experiment/.test(st) ? 2 : /spec|build|product/.test(st) ? 3 : DONE_STATES.has(st) ? 4 : 1;
  return PHASE_NAMES.map((name, i) => ({ n: i + 1, name, steps: [], gates: [],
    status: i + 1 < now ? "done" : i + 1 === now ? (STOP_STATES.has(st) ? "stopped" : DONE_STATES.has(st) ? "done" : "active") : "pending" }));
}

// ------------------------------------------------------------ inline text
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+|\bASSUMPTION\b|\bMOCKED\b|\bSTUBBED\b|\*[^*\s][^*]*\*)/;
function inline(text) {
  const out = [];
  for (const part of str(text).split(INLINE_RE)) {
    if (!part) continue;
    if (part === "ASSUMPTION") out.push(h("mark", { class: "assume", title: "Not backed by a checked source" }, "ASSUMPTION"));
    else if (part === "MOCKED" || part === "STUBBED") out.push(h("span", { class: "mockword " + part.toLowerCase() }, part));
    else if (/^\*\*[^*]+\*\*$/.test(part)) out.push(h("strong", null, inline(part.slice(2, -2))));
    else if (/^`[^`]+`$/.test(part)) out.push(h("code", null, part.slice(1, -1)));
    else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(part)) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part), href = safeHref(m[2]);
      out.push(href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, m[1]) : m[1]);
    } else if (/^https?:\/\//.test(part)) {
      const url = part.replace(/[.,;:!?'"]+$/, ""), tail = part.slice(url.length);
      out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
      if (tail) out.push(tail);
    } else if (/^\*[^*\s][^*]*\*$/.test(part)) out.push(h("em", null, part.slice(1, -1)));
    else out.push(part);
  }
  return out;
}

// ------------------------------------------------------------ markdown (safe, small)
function md(text) {
  const lines = str(text).replace(/\r\n?/g, "\n").split("\n");
  const root = h("div", { class: "md" });
  let para = [];
  const flush = () => { if (para.length) { root.append(h("p", null, inline(para.join(" ")))); para = []; } };
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      root.append(h("pre", { class: "code" }, code.join("\n"))); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { flush(); root.append(h("h" + Math.min(6, head[1].length + 2), null, inline(head[2].replace(/\s*#+\s*$/, "")))); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); root.append(h("hr")); continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const header = cells(line), rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      root.append(h("div", { class: "tablewrap" }, h("table", { class: "t" },
        h("thead", null, h("tr", null, header.map((c) => h("th", null, inline(c))))),
        h("tbody", null, rows.map((r) => h("tr", null, header.map((_, j) => h("td", null, inline(r[j] || "")))))))));
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush(); const ordered = /\d/.test(li[1]), items = [];
      for (; i < lines.length; i++) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[2].replace(/^\[( |x|X)\]\s+/, (_, c) => (c === " " ? "☐ " : "☑ ")));
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
      }
      i--;
      root.append(h(ordered ? "ol" : "ul", null, items.map((t) => h("li", null, inline(t)))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush(); const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      root.append(h("blockquote", null, inline(q.join(" ")))); continue;
    }
    para.push(line.trim());
  }
  flush();
  return root;
}

// ------------------------------------------------------------ artifacts
// Only MOCKED and STUBBED get a badge; a real ("Working") part needs none, so the labels that matter stand out.
function statusBadge(label) {
  const l = str(label);
  if (/STUBBED/.test(l)) return h("span", { class: "sbadge stubbed", title: "A placeholder. This part is not built yet." }, l);
  if (/MOCKED/.test(l)) return h("span", { class: "sbadge mocked", title: "A pretend version. Nothing real happens." }, l);
  return null;
}
function mockNote(label) {
  const l = str(label);
  if (/STUBBED/.test(l)) return h("div", { class: "mocknote stubbed" }, h("b", null, "STUBBED: "), "this part is a placeholder. It is not built yet, so nothing here does real work.");
  if (/MOCKED/.test(l)) return h("div", { class: "mocknote mocked" }, h("b", null, "MOCKED: "), "this is a pretend version. Nothing is published, sent or paid, and no money moves.");
  return null;
}
function artifactBody(content, ext) {
  const e = str(ext).toLowerCase(), c = str(content);
  if (!c.trim()) return h("div", { class: "empty small" }, "Nothing written yet.");
  if (e === "html" || e === "htm") return h("iframe", { class: "artframe", sandbox: "", srcdoc: c, title: "Page preview", loading: "lazy" });
  if (e === "json") {
    let pretty = c;
    try { pretty = JSON.stringify(JSON.parse(c), null, 2); } catch (_) { /* show as given */ }
    return h("pre", { class: "code" }, pretty);
  }
  if (e === "md" || e === "markdown" || e === "txt" || !e) return md(c);
  return h("pre", { class: "code" }, c);
}
function sourcesList(sources) {
  const list = arr(sources).map((u) => (typeof u === "string" ? u : obj(u).url)).filter((u) => safeHref(u));
  if (!list.length) return null;
  return h("div", { class: "sources" }, h("div", { class: "eyebrow" }, `Sources cited (${list.length})`),
    h("ul", null, list.map((u) => h("li", null, h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, hostOf(u)), h("span", { class: "muted small" }, " " + u)))));
}
function artifactView(step) {
  const st = obj(step);
  return h("div", { class: "artifact" },
    h("div", { class: "art-meta" }, statusBadge(st.status_label),
      st.agent ? h("span", { class: "muted small" }, `Written by ${humanName(st.agent).toLowerCase()}${st.model ? " with " + st.model : ", by code, no model"}`) : null,
      st.needs_approval ? h("span", { class: "badge pending" }, st.approved ? "Approved by you" : "Needs your approval") : null),
    mockNote(st.status_label),
    st.blocked ? h("div", { class: "kid-warn" }, "Held back: this draft broke a rule, so it is not used. It is kept here for the record.") : null,
    artifactBody(st.content, st.ext),
    sourcesList(st.sources));
}
// A collapsible artifact; the body is built only when opened.
function artifactDetails(step, open) {
  const st = obj(step), key = `${st.phase || ""}.${st.step || ""}.${st.name || ""}`;
  S.openDocs = S.openDocs || new Set();
  const isOpen = open || S.openDocs.has(key);
  const body = h("div", { class: "art-body" });
  const d = h("details", { class: "artdet", open: isOpen || null },
    h("summary", null, h("span", { class: "art-title" }, st.blocked ? str(st.title || humanName(st.name)).replace(/\s*\(blocked\)$/i, "") : st.title || humanName(st.name)),
      st.blocked ? h("span", { class: "badge rejected" }, "Held back") : null, statusBadge(st.status_label)), body);
  const build = () => { if (!body.firstChild) body.append(artifactView(st)); };
  if (isOpen) build();
  d.addEventListener("toggle", () => { if (d.open) { S.openDocs.add(key); build(); } else S.openDocs.delete(key); });
  return d;
}

// ------------------------------------------------------------ gate result card (a printed receipt)
// The big word with an offset copy in the other ink, aria-hidden, for a slightly misregistered print.
function verdictBig(outcome) {
  const out = str(outcome).toLowerCase(), word = OUTCOME_WORD[out] || "Waiting";
  return h("div", { class: `verdict-big o-${OUTCOME_WORD[out] ? out : "none"}`, style: `--len:${word.length}`, role: "img", "aria-label": `Result: ${word}` },
    h("span", { class: "vw", "aria-hidden": "true" }, word), h("span", { class: "vw-ghost", "aria-hidden": "true" }, word));
}
function lineItem(label, value, result, note) {
  const res = result === true ? ["pass", "pass"] : result === false ? ["fail", "fail"] : result ? [result, "unknown"] : null;
  return h("div", { class: "li" + (str(label).length > 44 ? " li-long" : "") }, h("span", { class: "li-label" }, inline(label)), h("span", { class: "li-val" }, str(value)),
    res ? h("span", { class: "li-res " + res[1] }, res[0]) : h("span"), note ? h("span", { class: "li-note" }, inline(note)) : null);
}
// The print animation plays once per gate decision, the first time this browser shows it.
function gateFresh(g) {
  S.printed = S.printed || new Set();
  const key = [g.phase, g.name, g.outcome, g.at].join("|");
  if (S.printed.has(key)) return false;
  S.printed.add(key);
  return true;
}
function gateCard(g, opts) {
  g = obj(g); opts = opts || {};
  const out = str(g.outcome).toLowerCase(), word = OUTCOME_WORD[out] || "Waiting";
  const checks = arr(g.checks).map(obj), hero = !opts.compact;
  let i = 0;
  const sec = (...kids) => h("div", { class: "sec pl", style: `--i:${i++}` }, kids);
  const parts = [
    sec(h("div", { class: "eyebrow" }, `${g.phase ? "Phase " + g.phase + ", " : ""}${(GATE_TYPE_LABEL[g.gate_type] || humanName(g.gate_type) || "gate").toLowerCase()}`),
      h("div", { class: "gate-head" }, h("span", { class: "gate-name" }, humanName(g.name) + " gate"), hero ? null : h("span", { class: "gword o-" + out }, word))),
    sec(h("p", { class: "gate-line" }, OUTCOME_LINE[out] || "Not decided yet."), g.reason ? h("p", { class: "gate-reason" }, inline(g.reason)) : null),
  ];
  if (out === "stop" && g.flip_test) parts.push(sec(h("div", { class: "fliptest" }, h("div", { class: "ft-label" }, "What would change this answer"), h("p", null, inline(g.flip_test)))));
  if (checks.length) parts.push(sec(checks.map((c) => lineItem(c.name, `${str(c.actual)} / ${str(c.target)}`, !!c.passed)),
    h("div", { class: "small muted" }, "Measured / pass mark set in advance.")));
  parts.push(sec(h("div", { class: "small muted" },
      g.decided_by === "founder" ? "Decided by you, the founder." : "Decided by code: plain arithmetic on the evidence, not a model.",
      g.at ? ` ${new Date(g.at).toLocaleString()}` : ""),
    g.override_reason ? h("div", { class: "override" }, h("div", { class: "k" }, "Founder override, kept on record"), h("div", null, `“${g.override_reason}”`)) : null,
    out !== "stop" && g.flip_test ? h("div", { class: "small muted" }, h("b", null, "What would change this: "), inline(g.flip_test)) : null));
  const fresh = gateFresh(g);
  // The big verdict sits beside the receipt where there is room, and wraps under it on a narrow screen.
  return h("div", { class: `gate slip o-${out || "none"}${opts.compact ? " compact" : " hero"}${fresh ? " print" : ""}`, style: `--n:${i}` },
    hero ? [h("div", { class: "gate-body" }, parts), h("div", { class: "sec gate-hero" }, verdictBig(out))] : parts);
}
// One line per gate (outcome, name, reason); the full receipt opens on demand.
function gateSummary(g, open) {
  g = obj(g);
  const out = str(g.outcome).toLowerCase(), body = h("div", { class: "art-body" });
  const d = h("details", { class: "artdet gate-sum", open: open || null },
    h("summary", null, h("span", { class: "gword o-" + out }, OUTCOME_WORD[out] || "Waiting"),
      h("span", { class: "art-title" }, h("b", null, humanName(g.name) + " gate"), g.reason ? h("span", { class: "gs-reason" }, " · ", inline(g.reason)) : null),
      h("span", { class: "gs-more" }, "Full result")), body);
  const build = () => { if (!body.firstChild) body.append(gateCard(g)); };
  if (open) build();
  d.addEventListener("toggle", () => { if (d.open) build(); });
  return d;
}

// ------------------------------------------------------------ loading pieces
const fmtDur = (secs) => {
  const t = Math.max(0, Math.round(Number(secs) || 0)), hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return hh ? `${hh}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};
// A preview page: a placeholder shows until the frame has loaded.
function frameBox(src, cls, title) {
  const box = h("div", { class: "frame-box loading" },
    h("div", { class: "frame-wait", "aria-hidden": "true" }, h("span", { class: "spin" }), "Loading the preview…"));
  box.append(h("iframe", { class: cls, src, title, onload: () => box.classList.remove("loading") }));
  return box;
}
// Shown the moment a page is opened, until its data arrives.
function runSkeleton(label) {
  const bar = (w, ht) => h("div", { class: "sk", style: `width:${w};height:${ht || 14}px` });
  return h("div", { class: "kid kid-runw skel", "aria-busy": "true" },
    h("div", { class: "running skel-label", role: "status" }, h("span", { class: "spin" }), label || "Loading the run…"),
    bar("100%", 70), bar("72%", 18),
    h("div", { class: "skel-tabs" }, ["96px", "120px", "112px", "90px"].map((w) => bar(w, 30))),
    h("div", { class: "kid-card" }, bar("46%", 28), bar("92%"), bar("84%"), bar("60%"), bar("100%", 120), bar("190px", 46)));
}

// ------------------------------------------------------------ document viewer
// A list of documents beside one open document, so reading never grows the page.
function docViewer(group, items) {
  S.docSel = S.docSel || {};
  if (!items.length) return h("div", { class: "empty" }, "Nothing here yet.");
  const sel = items.find((it) => it.key === S.docSel[group]) || items[0];
  const pane = h("div", { class: "dv-pane", role: "tabpanel", tabindex: "0" }), list = h("div", { class: "dv-list", role: "tablist", "aria-label": "Documents" });
  const show = (it) => {
    S.docSel[group] = it.key;
    for (const b of list.children) { const on = b.dataset.key === it.key; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
    fill(pane, it.render()); pane.scrollTop = 0;
  };
  for (const it of items) list.append(h("button", { class: "dv-item", role: "tab", "data-key": it.key, onclick: () => show(it) },
    h("span", { class: "dv-title" }, it.title, it.sub ? h("span", { class: "gate-nth" }, it.sub) : null), h("span", { class: "dv-tags" }, it.tags)));
  show(sel);
  return h("div", { class: "dv" }, list, pane);
}
// The documents and gate results of one phase, as viewer items.
function phaseItems(p) {
  const nth = gateNth(p.gates);
  return [
    ...p.steps.map((st) => ({ key: `s:${st.step || ""}:${st.name}`, render: () => artifactView(Object.assign({ phase: p.n }, st)),
      title: st.blocked ? str(st.title || humanName(st.name)).replace(/\s*\(blocked\)$/i, "") : st.title || humanName(st.name),
      tags: [st.blocked ? h("span", { class: "badge rejected" }, "Held back") : null, statusBadge(st.status_label),
        st.needs_approval && !st.approved ? h("span", { class: "badge pending" }, "Needs approval") : null] })),
    ...p.gates.map((g, gi) => ({ key: `g:${gi}:${g.name}`, title: humanName(g.name) + " gate", sub: nth[gi], render: () => gateCard(Object.assign({ phase: p.n }, g)),
      tags: [g.override_reason ? h("span", { class: "badge override-tag" }, "Your override") : null, h("span", { class: "gword o-" + str(g.outcome) }, OUTCOME_WORD[g.outcome] || "Waiting")] })),
  ];
}

// ------------------------------------------------------------ activity list
function activityList(s, view, limit) {
  const dec = view === "decisions", list = (dec ? s.decisions : s.trace).slice(-limit).reverse();
  if (!list.length) return h("div", { class: "empty" }, dec ? "No decisions yet." : "No agent steps yet.");
  return h("ol", { class: "act-list" }, list.map((t) => h("li", null, h("span", { class: "ts" }, time(t.ts)),
    h("div", null, h("div", { class: "who" }, dec ? humanName(t.actor) : str(t.agent), h("span", { class: "act" }, " · " + (dec ? str(t.kind).replace(/_/g, " ") : str(t.action)))),
      (dec ? t.summary : t.detail) ? h("div", { class: "det" }, str(dec ? t.summary : t.detail)) : null))));
}

// ------------------------------------------------------------ phase strip
function phaseStrip(s) {
  const phases = phaseList(s), stopped = isStopped(s);
  return h("ol", { class: "phases", "aria-label": "Six phases" }, phases.map((p) => {
    const gates = arr(p.gates).map(obj), nth = gateNth(gates);
    const status = stopped && p.status === "active" ? "stopped" : p.status;
    const label = { done: "Done", active: "Now", stopped: "Stopped here", pending: "Not started" }[status] || humanName(status);
    return h("li", { class: "ph " + status, "aria-current": status === "active" ? "step" : null },
      h("div", { class: "ph-top" }, h("span", { class: "ph-n" }, status === "done" ? "✓" : String(p.n)), h("span", { class: "ph-name" }, p.name)),
      h("div", { class: "ph-status" }, label),
      gates.length ? h("div", { class: "ph-gates" }, gates.map((g, gi) => h("span", { class: "gdot o-" + str(g.outcome), title: `${humanName(g.name)}${nth[gi] ? " (" + nth[gi] + ")" : ""}: ${OUTCOME_WORD[g.outcome] || "waiting"}`, role: "img", "aria-label": `${humanName(g.name)} gate${nth[gi] ? ", " + nth[gi] : ""}: ${OUTCOME_WORD[g.outcome] || "waiting"}` }))) : null);
  }));
}

// ------------------------------------------------------------ refusals and change requests
function refusalCard(r) {
  r = obj(r);
  // "phase N <step>" refusals hold an agent's own draft, not something the founder asked for.
  const drafted = /^phase \d/i.test(str(r.where)), text = str(r.text).trim(), long = text.length > 220;
  return h("div", { class: "refusal slip" },
    h("div", { class: "ref-head" }, "Refused"),
    h("div", { class: "eyebrow" }, "Refusal receipt", r.where ? `, ${humanName(r.where).toLowerCase()}` : "", r.at ? `, ${time(r.at)}` : ""),
    h("dl", { class: "kv" },
      h("dt", null, drafted ? "What an agent drafted" : "What was asked"),
      h("dd", null, long ? h("details", { class: "clamp" }, h("summary", null, `“${text.slice(0, 200).trim()}…” `, h("span", { class: "linkish" }, "Show all")), `“${text}”`) : `“${text}”`),
      h("dt", null, "Rule it breaks"), h("dd", null, humanName(r.rule) || "A safety rule"),
      h("dt", null, "Why"), h("dd", null, inline(r.reason)),
      r.substitute ? [h("dt", null, "What we can do instead"), h("dd", { class: "subst" }, inline(r.substitute))] : null));
}
function refusalsSection(s) {
  if (!s.refusals.length) return null;
  return h("div", { class: "kid-card" }, h("h3", null, `Refusals (${s.refusals.length})`),
    h("p", { class: "kid-hint" }, "Requests that break a rule are refused and kept here for good, with an honest alternative."),
    s.refusals.slice().reverse().map(refusalCard));
}
function askBox() {
  const ta = h("textarea", { class: "kid-input", rows: 2, placeholder: "For example: make the price lower, or change the headline." });
  const out = h("div", { class: "ask-out", "aria-live": "polite" });
  const btn = h("button", { class: "kid-btn", onclick: async () => {
    const text = ta.value.trim();
    if (!text) { fill(out, h("div", { class: "kid-warn" }, "Write what you would like to change first.")); return; }
    btn.disabled = true; btn.classList.add("is-busy"); fill(out, h("div", { class: "running small" }, h("span", { class: "spin" }), "Checking your request against the rules…"));
    try {
      const r = obj(await api("POST", runPath("/request"), { text }));
      if (r.refusal) fill(out, h("p", { class: "small" }, "This request was refused. It is saved below with the reason."), refusalCard(r.refusal));
      else if (r.accepted) { ta.value = ""; fill(out, h("div", { class: "kid-note" }, "Accepted. The team will use it in the next draft.")); }
      else fill(out, h("div", { class: "kid-note" }, "Your request was received."));
      refresh();
    } catch (e) { fill(out, h("div", { class: "kid-warn", role: "alert" }, e.message)); }
    btn.disabled = false; btn.classList.remove("is-busy");
  } }, "Send request");
  return h("details", { class: "kid-card ask" }, h("summary", null, "Ask for a change"),
    h("p", { class: "kid-hint" }, "Every request is checked against the rules first. If one breaks a rule, you get a refusal receipt and an honest alternative."),
    ta, h("div", { class: "kid-row" }, btn), out);
}

// ------------------------------------------------------------ cost footer and export
function renderCostBar() {
  const s = S.snap;
  let bar = $("#costbar");
  if (!s || !S.runId) { if (bar) bar.remove(); document.body.classList.remove("has-cost"); return; }
  if (!bar) { bar = h("footer", { id: "costbar", class: "costbar" }); document.body.append(bar); }
  document.body.classList.add("has-cost");
  const c = s.cost, models = c.models.map(str).filter(Boolean);
  const sig = JSON.stringify([c, S.runId]);
  if (bar.dataset && bar.dataset.sig === sig) return;
  if (bar.dataset) bar.dataset.sig = sig;
  fill(bar, h("span", { class: "cost-main" }, `Cost of this run: $${(Number(c.usd) || 0).toFixed(2)}`),
    h("span", { class: "cost-d" }, `${fmtInt(c.tokens_in)} tokens in, ${fmtInt(c.tokens_out)} out, ${fmtInt(c.calls)} model calls`),
    models.length ? h("span", { class: "cost-d cost-models" }, models.join(", ")) : null,
    h("button", { class: "linkish cost-x", onclick: exportOutputs }, "Export outputs"));
}
function modal(title, body) {
  const close = () => overlay.remove();
  const overlay = h("div", { class: "modal", onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "card modal-card", role: "dialog", "aria-label": title }, h("div", { class: "card-h" }, h("div", { class: "section-title" }, title),
      h("button", { class: "btn ghost sm", onclick: close }, "Close")), h("div", { class: "card-b" }, body)));
  document.body.append(overlay);
  return overlay;
}
async function exportOutputs() {
  const box = h("div", null, h("div", { class: "running" }, h("span", { class: "spin" }), "Writing the output files…"));
  modal("Export outputs", box);
  try {
    const r = obj(await api("POST", runPath("/export")));
    const files = arr(r.files || r.written || r.outputs).map((f) => (typeof f === "string" ? f : obj(f).file || obj(f).path || "")).filter(Boolean);
    fill(box, h("p", null, files.length ? `${files.length} files written${r.dir ? " to " + r.dir : ""}.` : "Export finished."),
      files.length ? h("ul", { class: "filelist" }, files.map((f) => h("li", { class: "mono small" }, f))) : null,
      h("p", { class: "small muted" }, "These are the outputs of this real run, with the decision log."));
  } catch (e) { fill(box, h("div", { class: "error", role: "alert" }, e.message)); }
}

// ------------------------------------------------------------ model status line
function modelLine(b) {
  b = obj(b);
  const models = [...new Set(Object.values(obj(b.models)).map(str).filter(Boolean))];
  if (b.available) {
    const where = b.backend === "ollama" ? "on this computer (Ollama)" : b.provider ? `via ${b.provider}` : b.label ? `via ${b.label}` : "";
    return h("div", { class: "modelline ok" }, h("span", { class: "dot ok" }),
      `Model in use: ${models.length ? models.join(", ") : b.model || "open-weight model"}${!(models.length || b.model) ? "" : b.open_weight === false ? " (Claude, opted in for testing; not open-weight)" : " (open-weight)"} ${where}.`.replace(/\s+\./, "."));
  }
  return h("div", { class: "modelline off" }, h("span", { class: "dot off" }), h("span", null, "No model is connected. ",
    str(b.help || b.how_to_enable) || "To run for free, install Ollama on this computer, pull an open-weight model such as Qwen, and reload this page."));
}

// ------------------------------------------------------------ start screen: founder brief
const BRIEF_FIELDS = [
  ["idea", "Idea", "text", "What you want to make, in a sentence"],
  ["skills", "Skills", "text", "For example: writing, spreadsheets, basic web design"],
  ["budget", "Budget", "number", "Total you can spend"],
  ["currency", "Currency", "text", "USD"],
  ["hours_per_week", "Hours per week", "number", "For example: 10"],
  ["weeks_available", "Weeks", "number", "For example: 8"],
  ["target_market", "Target market", "text", "Who and where, for example: freelance designers in Egypt"],
  ["values", "Values", "text", "For example: no ads, privacy first"],
];
function briefFromFields(vals) {
  const b = {};
  for (const [k, , type] of BRIEF_FIELDS) {
    const v = str(vals[k]).trim();
    if (!v) continue;
    if (k === "skills" || k === "values") b[k] = v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    else if (type === "number") { const n = Number(v.replace(/[^\d.]/g, "")); if (!Number.isNaN(n) && v) b[k] = n; }
    else b[k] = v;
  }
  return b;
}
function renderBriefHome() {
  if (S.view === "simple") renderSimpleTopbar(); else renderTopbar();
  clear($("#banner")); renderCostBar();
  const app = clear($("#app"));
  const b = (S.status && S.status.backend) || {};
  S.homeDraft = S.homeDraft || { text: "", fields: {} };
  const text = h("textarea", { class: "kid-input brief-box", rows: 9, "aria-label": "Founder brief",
    placeholder: "Paste your founder brief here. Say what you want to make, your skills, your budget, how many hours a week you have, who it is for, and what matters to you.",
    oninput: (e) => (S.homeDraft.text = e.target.value) });
  text.value = S.homeDraft.text;
  const inputs = BRIEF_FIELDS.map(([k, label, type, ph]) => {
    const el = h("input", { class: "kid-input sm", type: type === "number" ? "text" : "text", inputmode: type === "number" ? "decimal" : null,
      placeholder: ph, "aria-label": label, oninput: (e) => (S.homeDraft.fields[k] = e.target.value) });
    el.value = S.homeDraft.fields[k] || "";
    return h("label", { class: "kid-label sm" + (k === "idea" || k === "target_market" ? " wide" : "") }, label, el);
  });
  const err = h("div", { class: "inline-err", role: "alert", hidden: true });
  const go = h("button", { class: "kid-btn primary big", onclick: async () => {
    const t = text.value.trim(), fields = briefFromFields(S.homeDraft.fields);
    if (t.length < 10 && !fields.idea) { fill(err, "Paste a brief, or at least fill in the idea."); err.hidden = false; text.focus(); return; }
    const body = { mode: "live" };
    if (t) body.brief_text = t;
    if (Object.keys(fields).length) body.brief = Object.assign({ idea: fields.idea || t.slice(0, 200) }, fields);
    try { if (localStorage.getItem("rc_demo") === "1") body.demo = true; } catch (_) { /* demo mode is optional */ }
    go.disabled = true; go.classList.add("is-busy"); go.textContent = "Starting the run…"; err.hidden = true;
    try {
      const res = obj(await api("POST", "/api/runs", body));
      const id = res.run_id ?? res.id;
      S.homeDraft = null;
      location.hash = `#/run/${id}`;
    } catch (e) { fill(err, e.message); err.hidden = false; }
    go.disabled = false; go.classList.remove("is-busy"); go.textContent = "Start the run";
  } }, "Start the run");
  const runs = arr(S.status && S.status.runs).slice(0, 8);
  app.append(h("div", { class: "kid" },
    h("div", { class: "kid-hero" },
      h("h1", null, "Start from your founder brief"),
      h("p", null, "A team of agents takes your idea through six phases, checks every claim against real sources, and tells you plainly when to stop.")),
    h("div", { class: "kid-card" },
      h("label", { class: "kid-label" }, "Your founder brief", text),
      h("details", { class: "kid-more", open: Object.keys(S.homeDraft.fields).some((k) => S.homeDraft.fields[k]) || null },
        h("summary", null, "Add details as separate fields (optional)"),
        h("div", { class: "brief-grid" }, inputs)),
      err, go,
      modelLine(b),
      h("div", { class: "kid-hint center" }, "Your budget, hours, skills and values become hard limits that code checks at every step."),
      h("div", { class: "center" }, h("a", { href: "#/recorded" }, "See a recorded run"))),
    runs.length ? h("div", { class: "kid-card" }, h("h3", null, "Earlier runs"),
      h("div", { class: "kid-runs" }, runs.map((r) => {
        r = obj(r);
        const [label, cls] = runBadge(r);
        const when = r.created_at ? new Date(r.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
        return h("a", { class: "kid-runrow", href: `#/run/${r.id}` },
          h("span", { class: "kid-tag " + cls }, label),
          h("span", { class: "kid-runname" }, r.product_name || r.idea || `Run ${r.id}`),
          h("span", { class: "kid-runmeta" }, `Run ${r.id}${when ? " · " + when : ""}`));
      }))) : null));
}
function runBadge(r) {
  const st = str(r.state);
  if (DONE_STATES.has(st)) return ["Finished", "done"];
  if (STOP_STATES.has(st)) return ["Stopped", "stopped"];
  if (STATE_KINDS.has(st) || /^approve_phase/.test(st)) return ["Needs you", "you"];
  return ["Working", "busy"];
}

// ------------------------------------------------------------ recorded run viewer
async function renderRecorded() {
  if (S.view === "simple") renderSimpleTopbar(); else renderTopbar();
  clear($("#banner")); renderCostBar();
  const app = clear($("#app"));
  const wrap = h("div", { class: "kid" }, h("div", { class: "running" }, h("span", { class: "spin" }), "Loading the recorded run…"));
  app.append(wrap);
  let r;
  try { r = obj(await api("GET", "/api/recorded")); } catch (e) { fill(wrap, h("div", { class: "error", role: "alert" }, e.message)); return; }
  if (!location.hash.startsWith("#/recorded")) return;
  const outputs = arr(r.outputs).map(obj), log = arr(r.decision_log).map(obj);
  fill($("#banner"), h("div", { class: "banner rec" }, h("b", null, "Recorded run"),
    h("span", null, `This is a run recorded earlier${r.label ? ": " + r.label : ""}. It is read-only and is not happening live.`)));
  if (!r.available) {
    fill(wrap, h("div", { class: "kid-card" }, h("h2", null, "No recorded run yet"),
      h("p", null, "A recorded run appears here after a real run is exported."), h("a", { href: "#/" }, "Back to the start"))); return;
  }
  const ext = (f) => (/\.([a-z0-9]+)$/i.exec(f) || [])[1] || "txt";
  fill(wrap,
    h("h2", null, "Recorded run"), h("p", { class: "kid-hint" }, r.label || ""),
    h("div", { class: "kid-card" }, h("h3", null, `Output files (${outputs.length})`),
      outputs.map((o) => artifactDetails({ name: o.file, title: o.file, content: o.content, ext: ext(str(o.file)),
        status_label: /MOCKED/.test(str(o.content).slice(0, 400)) ? "MOCKED" : /STUBBED/.test(str(o.content).slice(0, 400)) ? "STUBBED" : "Working" }))),
    h("div", { class: "kid-card" }, h("h3", null, `Decision log (${log.length} entries)`),
      h("div", { class: "tablewrap" }, h("table", { class: "t small" },
        h("thead", null, h("tr", null, ["Time", "Agent", "Action", "Outcome", "Model", "Cost", "Approved by", "Sources"].map((x) => h("th", null, x)))),
        h("tbody", null, log.map((e) => h("tr", { class: e.outcome === "refused" ? "refused-row" : "" },
          h("td", { class: "num" }, str(e.timestamp).replace("T", " ").slice(0, 19)), h("td", null, str(e.agent)), h("td", null, inline(e.action)),
          h("td", null, str(e.outcome)), h("td", { class: "small" }, str(e.model)), h("td", { class: "num" }, e.cost == null ? "" : `$${Number(e.cost).toFixed(4)}`),
          h("td", null, str(e.approved_by)),
          h("td", null, arr(e.sources).filter(safeHref).map((u) => h("div", null, h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, hostOf(u))))))))))),
    h("a", { href: "#/" }, "Back to the start"));
}
