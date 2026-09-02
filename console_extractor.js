/*
 * Paste this into your browser's DevTools Console (F12, or right-click ->
 * Inspect -> Console tab) while viewing a loaded search-results page on
 * https://finder.startupnationcentral.org/startups/search?keywords=...&page=N
 *
 * It finds every startup on the page, and downloads a JSON file named
 * startups_page_<N>.json (page number read from the URL) to your normal
 * Downloads folder.
 *
 * Run this once per page: page=1, page=2, page=3, ... until a page downloads
 * a file with 0 entries (or the page number in the URL stops changing what's
 * shown) -- that's the end of the results. Then run combine_scraped_pages.py
 * over your Downloads folder to merge everything into one table.
 */
(function () {
  const BASE = location.origin;
  const linkPattern = /^\/startups\/(?!search\b)[^/?#]+\/?$/i;
  const seen = new Set();
  const results = [];

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    let abs;
    try {
      abs = new URL(href, BASE);
    } catch (e) {
      return;
    }
    if (!linkPattern.test(abs.pathname)) return;
    const url = abs.href;
    if (seen.has(url)) return;
    seen.add(url);

    let name = (a.innerText || "").trim();
    if (!name) {
      const slug = abs.pathname.replace(/\/$/, "").split("/").pop();
      name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // Walk up a few ancestors to grab the card's full text as extra context.
    let node = a,
      text = "";
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (node) {
        const t = node.innerText || "";
        if (t.length > text.length) text = t;
      }
    }
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => l.toLowerCase() !== name.toLowerCase());

    results.push({ name, url, details: lines.slice(0, 5).join(" | ") });
  });

  const pageNum = new URLSearchParams(location.search).get("page") || "1";
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `startups_page_${pageNum}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  console.log(`Extracted ${results.length} startup(s) from page ${pageNum}.`, results);
  if (results.length === 0) {
    console.warn("0 startups found -- this may be the last page, or the page hasn't finished loading yet.");
  }
})();
