/*
 * Diagnostic-only script. Paste into DevTools Console on a loaded search
 * results page. Does NOT download anything -- just prints info to help
 * figure out the real markup so console_extractor.js can be fixed.
 */
(function () {
  const allLinks = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
  const uniquePaths = [...new Set(allLinks)];

  console.log(`Total <a href> elements on page: ${allLinks.length}`);
  console.log("First 40 unique href values:");
  console.table(uniquePaths.slice(0, 40));

  // Look for anything that smells like a startup detail link.
  const suspects = uniquePaths.filter((h) => /startup|company|profile|organization/i.test(h));
  console.log("Hrefs containing 'startup' / 'company' / 'profile' / 'organization':");
  console.table(suspects);

  // Report page title and a snippet of body text to sanity check we're past
  // any Cloudflare challenge and looking at real results.
  console.log("Page title:", document.title);
  console.log("Body text (first 500 chars):", document.body.innerText.slice(0, 500));

  // How many "card"-like repeating elements are there? Rough heuristic: any
  // class name that appears on 5+ elements might be a card/list-item class.
  const classCounts = {};
  document.querySelectorAll("[class]").forEach((el) => {
    el.className
      .toString()
      .split(/\s+/)
      .forEach((c) => {
        if (!c) return;
        classCounts[c] = (classCounts[c] || 0) + 1;
      });
  });
  const repeatedClasses = Object.entries(classCounts)
    .filter(([, count]) => count >= 5 && count <= 200)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  console.log("Class names appearing 5-200 times (likely card/list/row classes):");
  console.table(repeatedClasses);
})();
