/*
 * Paste into DevTools Console on a loaded search-results page (after solving
 * any Cloudflare check, so the tab already has a valid session/cookies).
 *
 * The search URL itself returns a raw JSON API response (not HTML), shaped
 * like: {"count": 14059, "results": [{...}], "limit": 50, "skip": 0, ...}.
 * Pagination is keyed off the "page" query param (skip/limit in the response
 * are just an echo of what "page" resolved to server-side -- passing "skip"
 * directly is ignored). This script pages through via page=1,2,3,... until
 * it has every result, then downloads one combined JSON file:
 * startups_all.json.
 *
 * This can take a while for a broad keyword (potentially thousands of
 * results, hundreds of requests) -- watch the console log for progress.
 * Edit KEYWORDS below if needed.
 */
(async function () {
  const KEYWORDS = new URLSearchParams(location.search).get("keywords") || "startup";
  const DELAY_MS = 250; // politeness delay between requests
  const MAX_PAGES = 1000; // safety cap

  let page = 1;
  let total = Infinity;
  let pageSize = null;
  const all = [];
  const seenIds = new Set();

  while (all.length < total && page <= MAX_PAGES) {
    const url = `${location.pathname}?keywords=${encodeURIComponent(KEYWORDS)}&page=${page}`;
    let res, data;
    try {
      res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      data = await res.json();
    } catch (e) {
      console.error(`Request failed at page=${page}:`, e);
      break;
    }

    if (typeof data.count === "number") total = data.count;
    const batch = data.results || [];
    if (batch.length === 0) {
      console.log(`No results at page=${page}, stopping.`);
      break;
    }
    if (pageSize === null) pageSize = batch.length;

    let newCount = 0;
    for (const item of batch) {
      const id = item._id || item.urlname;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        all.push(item);
        newCount++;
      }
    }

    console.log(`page=${page}: got ${batch.length} (${newCount} new), total collected ${all.length}/${total}`);

    if (newCount === 0) {
      console.log("This page added nothing new (pagination likely maxed out or looping), stopping.");
      break;
    }

    page += 1;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "startups_all.json";
  document.body.appendChild(link);
  link.click();
  link.remove();

  console.log(`Done. Downloaded ${all.length} startup(s) to startups_all.json.`);
})();
