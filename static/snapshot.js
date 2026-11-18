
(function () {
  const BASE = location.pathname.replace(/[^/]*$/, "");
  const RUNS = new Set([1, 9]);
  const RO = "Read-only snapshot: this copy on GitHub Pages cannot start or change runs. Run Receipts locally with docker compose up to try it.";
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    init = init || {};
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const method = (init.method || "GET").toUpperCase();
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      if (method !== "GET") return json({ detail: RO }, 403);
      const m = url.pathname.match(/^\/api\/runs\/(\d+)$/);
      if (m && !RUNS.has(Number(m[1]))) return json({ detail: "This snapshot only includes runs " + [...RUNS].join(" and ") + "." }, 404);
      return real(BASE + url.pathname.slice(1) + ".json");
    }
    return real(input, init);
  };
  // Links to the generated pages point at the static copies.
  const fix = (a) => {
    const m = (a.getAttribute("href") || "").match(/^\/(p|app|store)\/([a-z0-9-]+)/);
    if (m) a.setAttribute("href", BASE + m[1] + "/" + m[2] + ".html");
  };
  new MutationObserver((ms) => ms.forEach((mu) => mu.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.matches("a[href]")) fix(n);
    n.querySelectorAll("a[href]").forEach(fix);
  }))).observe(document.documentElement, { childList: true, subtree: true });
  if (!location.hash || location.hash === "#") location.replace("#/run/1");
})();
