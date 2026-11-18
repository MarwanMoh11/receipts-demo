// Demo mode (a per-browser toggle in the top bar), for showcasing the app with button presses only:
// - the start screen gets "Type brief A" / "Type brief B", which type the demo briefs into the separate
//   brief fields (Idea, Skills, Budget, ...), one field after another;
// - the interview step gets "Simulate interviews", where the demo model writes fictional notes that the
//   server stores as MOCKED (never as founder-entered) and that count only in that run.
// Loaded after app.js; it wraps a few render functions instead of editing them.
(function () {
  const KEY = "rc_demo";
  // Keys match BRIEF_FIELDS in parts.js; values are what a founder would type into each field.
  const BRIEFS = {
    A: {
      idea: "A simple website that plans a week of easy family dinners and turns them into one shopping list, so busy parents stop deciding what to cook every evening.",
      skills: "Home cooking, writing, using spreadsheets",
      budget: "100", currency: "USD", hours_per_week: "6", weeks_available: "8",
      target_market: "Busy working parents with young children who cook dinner at home most nights",
      values: "Honest marketing, no ads, keep family details private",
    },
    B: {
      idea: "A paid newsletter that sends crypto trading signals telling subscribers which coins to buy and sell each morning.",
      skills: "Python, writing",
      budget: "50", currency: "USD", hours_per_week: "5", weeks_available: "4",
      target_market: "Retail crypto traders",
      values: "Honest marketing",
    },
  };

  const on = () => { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } };
  function setOn(v) {
    try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (_) { /* per-browser convenience only */ }
    if (S.runId && S.snap) { S.sig = {}; S.kidKey = null; S.nowKey = null; renderRun(); } else route();
    topbarToggle();
  }

  const style = document.createElement("style");
  style.textContent = `
    .demo-toggle[aria-pressed="true"] { background: var(--orange); border-color: var(--orange); color: var(--ink); }
    .demo-box { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 14px; }
    .demo-box .kid-btn { min-height: 40px; padding: 6px 14px; }
    .demo-panel { margin: 12px 0; display: grid; gap: 10px; }
    .demo-panel .kid-row { margin: 0; }`;
  document.head.append(style);

  // ---- top bar toggle (both views)
  function topbarToggle() {
    const right = $("#topbar-right");
    if (!right) return;
    const old = right.querySelector(".demo-toggle");
    if (old) old.remove();
    right.prepend(h("button", { class: "kid-topbtn demo-toggle", "aria-pressed": on() ? "true" : "false",
      title: "Demo mode types the demo briefs and can simulate interviews (marked MOCKED)", onclick: () => setOn(!on()) },
    on() ? "Demo mode: on" : "Demo mode"));
  }
  for (const name of ["renderSimpleTopbar", "renderTopbar"]) {
    const orig = window[name];
    if (typeof orig !== "function") continue;
    window[name] = function () { const r = orig.apply(this, arguments); topbarToggle(); return r; };
  }

  // ---- start screen: type brief A or B into the separate fields
  function typeFields(box, brief, buttons) {
    S.homeDraft = S.homeDraft || { text: "", fields: {} };
    box.value = ""; S.homeDraft.text = "";   // the fields carry the whole brief
    const more = $(".kid-more");
    if (more) more.open = true;
    const inputs = {};
    for (const [k, label] of BRIEF_FIELDS) {
      const el = document.querySelector(`.brief-grid input[aria-label="${label}"]`);
      if (el) { inputs[k] = el; el.value = ""; S.homeDraft.fields[k] = ""; }
    }
    const order = BRIEF_FIELDS.map(([k]) => k).filter((k) => inputs[k] && brief[k]);
    const put = (k, t) => { inputs[k].value = t; S.homeDraft.fields[k] = t; };
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { order.forEach((k) => put(k, brief[k])); return; }
    buttons.forEach((b) => (b.disabled = true));
    const total = order.reduce((n, k) => n + brief[k].length, 0);
    const step = Math.max(1, Math.ceil(total / 170));   // about 3 s for the whole brief
    let f = 0, i = 0;
    const done = () => { buttons.forEach((b) => (b.disabled = false)); const go = $(".kid-btn.primary.big"); if (go) go.focus(); };
    const tick = () => {
      if (!box.isConnected) return;
      if (f >= order.length) { done(); return; }
      const k = order[f], text = brief[k];
      if (i === 0) inputs[k].focus({ preventScroll: false });
      i = Math.min(text.length, i + step);
      put(k, text.slice(0, i));
      if (i >= text.length) { f += 1; i = 0; setTimeout(tick, 120); } else setTimeout(tick, 16);
    };
    tick();
  }
  const origHome = window.renderBriefHome;
  if (typeof origHome === "function") {
    window.renderBriefHome = function () {
      const r = origHome.apply(this, arguments);
      const box = $(".brief-box");
      if (on() && box) {
        const label = box.closest("label") || box;
        const btns = [];
        const mk = (k, what) => {
          const b = h("button", { class: "kid-btn", type: "button", onclick: () => typeFields(box, BRIEFS[k], btns) }, `Type brief ${k}`);
          b.title = what; btns.push(b); return b;
        };
        label.before(h("div", { class: "demo-box" }, h("b", null, "Demo mode"),
          mk("A", "The main demo: a weekly family dinner planner with one shopping list"),
          mk("B", "The refusal: a crypto trading-signals newsletter")));
      }
      return r;
    };
  }

  // ---- interview step: simulate notes with the demo model (MOCKED)
  const origInterviews = window.kidInterviews;
  if (typeof origInterviews === "function") {
    window.kidInterviews = function (card) {
      const r = origInterviews.apply(this, arguments);
      if (!on() || !card) return r;
      const st = (S.status && S.status.demo) || {};
      const lead = [...card.querySelectorAll(".kid-note b")].find((b) => /never invents interviews/i.test(b.textContent));
      if (lead) lead.textContent = "Outside demo mode, the system never invents interviews. ";
      const go = h("button", { class: "kid-btn primary", disabled: !st.interviews,
        onclick: () => act("POST", runPath("/interviews/simulate"), {}, "Simulated notes added. They are marked MOCKED.") },
      "Simulate interviews (MOCKED)");
      const panel = h("div", { class: "mocknote mocked demo-panel", role: "note" },
        h("div", null, h("b", null, "MOCKED · Demo mode. "),
          `${st.model || "The demo model"} writes a few fictional interview notes from the kit above, about made-up people. `,
          "They are marked MOCKED in the ledger, the notes and the evidence gate, and count only in this run."),
        h("div", { class: "kid-row" }, go),
        st.interviews ? null : h("div", { class: "kid-hint" }, st.reason || "Simulated interviews are not available on this server."));
      const firstNote = [...card.children].find((el) => el.classList.contains("kid-note"));
      card.insertBefore(panel, firstNote || card.children[1] || null);
      return r;
    };
  }

  topbarToggle();
})();
