/* LibRead for CrossInk, adapted from the MIT-licensed CrossPoint plugin. */
(function () {
  "use strict";

  const SITE = "https://libread.com";
  const ROOT = "/LibRead";          // library.json and downloaded books
  const LIB_FILE = "library.json";
  const DELAY_MS = 1200;            // pause between chapter requests (be polite)
  const PAGE_SIZE = 200;            // libread.com caps ?ajax=chapters pageSize at 200
  const CHECKPOINT_EVERY = 50;      // save a partial EPUB every N new chapters
  const STATUSES = ["ONGOING", "COMPLETED", "HIATUS", "STUB", "DROPPED", "INACTIVE"];

  // ---------------------------------------------------------------- small helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const num = (m) => (m ? parseInt(String(m[1]).replace(/,/g, ""), 10) : null);
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  // Proper URL resolution: absolute, protocol-relative, root- and path-relative
  const absFor = (base, href) => {
    if (!href) return "";
    try { return new URL(href, base || SITE).href; } catch (e) { return /^https?:/i.test(href) ? href : ""; }
  };
  const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(BAD_XML, "")
      .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const safeName = (s) =>
    String(s || "Untitled").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) ||
    "Untitled";
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const pickStatus = (labels) => labels.find((l) => STATUSES.includes(l)) || "UNKNOWN";
  const uniq = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  // Novel URLs: https://libread.com/libread/<slug>-<id> (chapter links have /chapter-NN)
  const novelIdOf = (value) => {
    try {
      const url = new URL(value);
      if (url.origin !== SITE || url.username || url.password) return null;
      return url.pathname.match(/^\/libread\/([a-z0-9-]+-\d+)(?:\/|$)/i)?.[1] || null;
    } catch (_) { return null; }
  };
  const novelUrlOf = (url) => { const id = novelIdOf(url); return id ? SITE + "/libread/" + id : null; };
  const chapterNumOf = (url) => { const m = String(url || "").match(/\/chapter-(\d+)/i); return m ? parseInt(m[1], 10) : null; };

  // ---------------------------------------------------------------- device file access
  async function readSd(path, as) {
    const r = await fetch("/download?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("Reading " + path + " failed (HTTP " + r.status + ")");
    return as === "blob" ? r.blob() : r.text();
  }
  function fileOp(endpoint, fields) {
    return fetch(endpoint, { method: "POST", body: new URLSearchParams(fields) });
  }

  async function uploadSd(dir, name, blob) {
    // CrossInk v1.6.1 refuses multipart overwrites and EPUB type changes on rename.
    const suffix = name.slice(name.lastIndexOf("."));
    const token = Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(16).padStart(8, "0")).join("");
    const staged = "libread-new-" + token + suffix;
    const backup = "libread-backup-" + token + suffix;
    const rename = (from, to) => fileOp("/rename", { path: dir + "/" + from, name: to });
    const body = new FormData();
    body.append("file", blob, staged);
    const r = await fetch("/upload?path=" + encodeURIComponent(dir), { method: "POST", body });
    if (!r.ok) throw new Error("Saving " + name + " failed: " + (await r.text()));

    try {
      const moved = await rename(name, backup);
      if (!moved.ok && moved.status !== 404) throw new Error(await moved.text());
      const promoted = await rename(staged, name);
      if (!promoted.ok) {
        if (moved.ok) await rename(backup, name);
        throw new Error(await promoted.text());
      }
      if (moved.ok) await fileOp("/delete", { path: dir + "/" + backup }).catch(() => {});
    } catch (e) {
      throw new Error("Could not finish saving " + name + ": " + e.message +
        ". Check " + dir + " for recovery files " + staged + " and " + backup + ".");
    }
  }

  async function ensureRoot() {
    const r = await fetch("/mkdir", {
      method: "POST", body: new URLSearchParams({ name: ROOT.slice(1), path: "/" }),
    });
    if (!r.ok && (await r.text()).trim() !== "Folder already exists") {
      throw new Error("Could not create " + ROOT + " (HTTP " + r.status + ")");
    }
  }

  if (document.getElementById("crossink-libread")) return;
  const host = document.createElement("section");
  host.id = "crossink-libread";
  const container = document.createElement("div");
  container.className = "lr";
  host.attachShadow({ mode: "open" }).appendChild(container);
  document.body.prepend(host);

  function start() {
    // ---- device status (screen profile for cover sizing)
    let deviceInfo = null;
    async function getDevice() {
      if (deviceInfo) return deviceInfo;
      try {
        const j = await (await fetch("/api/status")).json();
        const dev = j.device === "X4" ? "X4" : "X3";
        deviceInfo = { device: dev, w: dev === "X4" ? 480 : 528, h: dev === "X4" ? 800 : 792 };
      } catch (e) { deviceInfo = { device: "X3", w: 528, h: 792 }; }
      return deviceInfo;
    }

    async function fetchSource(url, kind) {
      if (stopRequested) throw new Error("Stopped.");
      const response = await chrome.runtime.sendMessage({ type: "libread-fetch", url, kind });
      if (!response?.ok) throw new Error(response?.error || "LibRead request failed");
      return response;
    }

    async function fetchDoc(url) {
      const { text, finalUrl } = await fetchSource(url, "text");
      const doc = new DOMParser().parseFromString(text, "text/html");
      if (/^(just a moment|attention required|please wait|checking your browser)/i.test(doc.title)) {
        throw new Error("The site returned a bot check. Try again later.");
      }
      doc.__url = finalUrl;
      return doc;
    }

    // ---------------------------------------------------------------- parsing: lists
    const metaContent = (doc, names) => {
      for (const n of names) {
        const el = doc.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]');
        const v = el && el.getAttribute("content");
        if (v) return v.trim();
      }
      return "";
    };
    // Card list shared by search results and browse pages: .col-content .con (search),
    // .ul-list1 / .ss-custom / .archive items (browse), with tolerant fallbacks.
    function parseCards(doc) {
      const base = doc.__url || SITE;
      let cards = [...doc.querySelectorAll(".col-content .con, .ul-list1 > li, .ss-custom > li, .archive > li")];
      if (!cards.length) {
        const byHref = new Map();
        for (const a of doc.querySelectorAll('a[href*="/libread/"]')) {
          const href = absFor(base, a.getAttribute("href") || "");
          if (!novelIdOf(href) || href.includes("/chapter-")) continue;
          if (!byHref.has(href)) byHref.set(href, a.closest("li, article, div") || a.parentElement || a);
        }
        cards = [...byHref.values()];
      }
      const out = [], seen = new Set();
      for (const card of cards) {
        const a = card.querySelector("h3.tit a, h3 a, .txt h3 a, a[href*='/libread/']");
        if (!a) continue;
        const url = absFor(base, a.getAttribute("href") || "");
        const id = novelIdOf(url);
        if (!id || seen.has(id) || url.includes("/chapter-")) continue;
        seen.add(id);
        const img = card.querySelector(".pic img, img");
        const cover = img ? absFor(base, img.getAttribute("src") || img.getAttribute("data-src") || "") : "";
        const t = txt(card);
        out.push({
          id, url: SITE + "/libread/" + id, title: txt(a) || "Untitled",
          author: txt(card.querySelector('a[href*="/author/"]')),
          status: pickStatus((t.match(/OnGoing|Completed|Hiatus|Stub|Dropped|Inactive/gi) || []).map((s) => s.toUpperCase())),
          chapters: num(t.match(/([\d,]+)\s+Chapters?/i)),
          genres: uniq([...card.querySelectorAll('a[href*="/genre/"]')].map(txt)),
          coverUrl: cover && !/noimage|nocover|^data:/i.test(cover) ? cover : "",
          blurb: txt(card.querySelector(".inner, .desc, .des, p")).slice(0, 400),
        });
      }
      return out;
    }

    // ---------------------------------------------------------------- parsing: novel page
    function parseChapterLinks(doc, root) {
      const base = (doc && doc.__url) || SITE;
      const out = [], seen = new Set();
      for (const a of (root || doc).querySelectorAll("a[href]")) {
        const href = absFor(base, a.getAttribute("href") || "");
        const n = chapterNumOf(href);
        if (n == null || seen.has(n)) continue;
        seen.add(n);
        out.push({ id: String(n), title: txt(a) || "Chapter", url: href });
      }
      return out;
    }
    // Full chapter list: the page's own ul#idData, reconciled with ?ajax=chapters
    // pages (the site caps pageSize at 200), exactly as WebToEpub reads them.
    async function chapterList(doc) {
      const base = (doc.__url || SITE + "/libread/").split("?")[0];
      let chapters = parseChapterLinks(doc, doc.querySelector("ul#idData"));
      // totalPage: from #indexselect option count, or a script (WebToEpub's heuristic)
      let altTotal = 1;
      const sel = doc.querySelector("#indexselect");
      if (sel) altTotal = Math.max(1, sel.querySelectorAll("option").length);
      else {
        for (const s of doc.querySelectorAll("script")) {
          const m = s.textContent.match(/totalPage\s*:\s*(\d+)/);
          if (m) { altTotal = parseInt(m[1], 10); break; }
        }
      }
      const seen = new Set(chapters.map((c) => c.id));
      let totalPage = 1, totalChapters = 0;
      for (let page = 1; page <= totalPage && !stopRequested; page++) {
        setStatus("Reading the chapter list" + (totalPage > 1 ? ", page " + page + " of " + totalPage : "") + "\u2026");
        if (page > 1) await sleep(DELAY_MS);
        try {
          const j = JSON.parse((await fetchSource(
            base + "?ajax=chapters&page=" + page + "&pageSize=" + PAGE_SIZE, "text")).text);
          if (!j || j.code !== 200 || !j.html) throw new Error("unexpected chapter-list answer");
          if (page === 1) { totalChapters = j.totalChapters || 0; totalPage = j.totalPage || altTotal || 1; }
          const fragment = new DOMParser().parseFromString(j.html, "text/html");
          fragment.__url = base;
          const part = parseChapterLinks(fragment, null);
          for (const c of part) if (!seen.has(c.id)) { seen.add(c.id); chapters.push(c); }
          if (!part.length) break; // past the end
        } catch (e) {
          if (!chapters.length) throw new Error("No chapter list found on the novel page (" + e.message + ")");
          if (page === 1) log("Full chapter list unavailable (" + e.message + "); using the page's own list.");
          break;
        }
      }
      if (totalChapters && chapters.length < totalChapters) {
        log("Site reports " + totalChapters + " chapters; list holds " + chapters.length + ".");
      }
      chapters.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
      return chapters;
    }
    async function getFiction(url) {
      const novelUrl = novelUrlOf(url) || url;
      const doc = await fetchDoc(novelUrl);
      const base = doc.__url || novelUrl;
      const title = txt(doc.querySelector(".m-desc h1.tit, .books h3.tit, h1.tit")) ||
        metaContent(doc, ["og:title"]).replace(/\s*\|\s*Lib\s*Read\s*$/i, "") || "Untitled";
      const itemBy = (t) => {
        const sp = doc.querySelector('.m-imgtxt .item span[title="' + t + '"], .books .item span[title="' + t + '"]');
        return sp ? sp.parentElement : null;
      };
      const authorEl = itemBy("Author");
      const author = txt(authorEl && authorEl.querySelector("a")) ||
        txt(doc.querySelector('a[href*="/author/"]')) || "Unknown";
      const genreEl = itemBy("Genre");
      const genres = genreEl ? uniq([...genreEl.querySelectorAll("a")].map(txt))
        : uniq([...doc.querySelectorAll('a[href*="/genre/"]')].map(txt)).slice(0, 12);
      const statusEl = itemBy("Status");
      const status = pickStatus([txt(statusEl).toUpperCase(),
        ...[...doc.querySelectorAll(".m-imgtxt .item, .books .item")].map((e) => txt(e).toUpperCase())]);
      const coverEl = doc.querySelector(".m-imgtxt .pic img, .books .pic img, div.pic img");
      const coverUrl = absFor(base, (coverEl && (coverEl.getAttribute("src") || coverEl.getAttribute("data-src"))) ||
        metaContent(doc, ["og:image", "twitter:image"]));
      const descEl = doc.querySelector(".m-desc .txt .inner, .desc-text, .m-desc .txt, .desc, .m-desc");
      const descriptionX = descEl ? toXhtml(descEl) : "";
      const chapters = await chapterList(doc);
      if (!chapters.length) throw new Error("No chapters found on " + novelUrl);
      const typeA = doc.querySelector('a[href*="/sort/latest-release/"]');
      return {
        id: novelIdOf(base) || novelIdOf(novelUrl) || safeName(title),
        url: novelUrl, title, author, status: status === "UNKNOWN" ? "UNKNOWN" : status,
        coverUrl, genres, descriptionX,
        descriptionText: descEl ? txt(descEl) : metaContent(doc, ["og:description", "description"]),
        type: typeA ? txt(typeA) : "", chapters, total: chapters.length,
      };
    }

    // ---------------------------------------------------------------- parsing: chapter text
    // Follows the cleanup used by WebToEpub's FreeWebNovelParser, LNReader's libread
    // filters and lightnovel-crawler's freewebnovel template.
    function sortReaderOrder(content) {
      if (content.getAttribute("data-reader-order") !== "pending") return;
      const kids = [...content.children];
      const key = (el) => {
        const idx = parseInt(el.getAttribute("data-reader-order-index"), 10);
        if (Number.isFinite(idx)) return idx;
        const m = (el.getAttribute("style") || "").match(/(?:^|;)\s*order\s*:\s*(-?\d+)/i);
        return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; // unmarked (ads) sink
      };
      const keyed = kids.map((el, i) => ({ el, k: key(el), i }));
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      const frag = content.ownerDocument.createDocumentFragment();
      for (const { el } of keyed) frag.appendChild(el); // re-append in order
      content.appendChild(frag);
    }
    function cleanupContent(content, doc) {
      // A style block (often in <head>) hides the promo paragraph:
      // p:nth-last-child(N){display:none} — apply it in the original DOM order,
      // before the reader-order sort moves anything.
      const hideLast = new Set();
      for (const s of (doc || content.ownerDocument).querySelectorAll("style")) {
        for (const m of s.textContent.matchAll(/p\s*:\s*nth-last-child\s*\(\s*(\d+)\s*\)\s*\{[^}]*display\s*:\s*none/gi)) {
          hideLast.add(parseInt(m[1], 10));
        }
      }
      for (const n of hideLast) {
        let el = null;
        try { el = content.querySelector("p:nth-last-child(" + n + ")"); } catch (e) { /* bad selector */ }
        if (el) el.remove();
      }
      sortReaderOrder(content);
      const DROP = "script, style, iframe, noscript, ins, sub, form, button, input, select, textarea, " +
        "video, audio, object, embed, svg, nav, h1, h2, h3, h4, h5, h6";
      const DROP_SEL = DROP + ", div[id^='pf-'], div[id^='bg-ssp-'], [class*='ads'], " +
        "[class*='unlock-buttons'], img[src*='wait-'], [style*='display: none'], [style*='display:none']";
      content.querySelectorAll(DROP_SEL).forEach((e) => e.remove());
      // Empty ad/wrapper divs left behind
      for (const d of [...content.querySelectorAll("div")]) {
        if (!d.children.length && !txt(d)) d.remove();
      }
      stripInlineTitle(content);
    }
    // The page repeats the chapter heading as an inline <h4>/<h6> or a short first <p>,
    // sometimes stuttered ("Chapter 1: Chapter 1: ..."). The EPUB gets its own title
    // element at the top of the file, so drop the duplicate here.
    function stripInlineTitle(content) {
      const firstP = content.querySelector("p");
      if (firstP) {
        const t = txt(firstP);
        const looksTitle = /^chapter\s*\d+\s*[-–—:.]/i.test(t) && t.length <= 120;
        if (looksTitle) firstP.remove();
      }
      // Collapse a stuttered "Chapter N: Chapter N: ..." prefix on the first text
      const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT, null, false);
      let node = walker.nextNode();
      while (node && !/\S/.test(node.nodeValue)) node = walker.nextNode();
      if (node) {
        const m = node.nodeValue.match(/^((?:chapter\s*\d+\s*[:\-–—.\s]+)+)/i);
        if (m) {
          const reps = m[1].match(/chapter\s*\d+\s*[:\-–—.\s]*/gi);
          if (reps && reps.length > 1) node.nodeValue = reps[0] + node.nodeValue.slice(m[1].length);
        }
      }
    }
    async function parseChapter(doc) {
      const content = doc.querySelector("#article") || doc.querySelector("#chr-content") ||
        doc.querySelector("#chapter-content") || doc.querySelector(".m-read .txt") ||
        doc.querySelector(".m-read") || doc.querySelector("div.txt");
      if (!content) {
        throw new Error("Chapter text not found on the page");
      }
      cleanupContent(content, doc);
      const bodyX = toXhtml(content);
      if (!bodyX.replace(/\s+/g, "")) throw new Error("Chapter came back empty");
      return bodyX;
    }

    // HTML -> clean XHTML (allow-list of tags, no attributes except centring)
    const KEEP = new Set(["p", "div", "br", "hr", "em", "i", "strong", "b", "u", "s", "del", "sup",
      "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "pre", "code"]);
    const DROP_TAGS = new Set(["script", "style", "iframe", "noscript", "svg", "button", "form", "input",
      "select", "textarea", "video", "audio", "object", "embed", "img"]);
    function toXhtml(node) {
      let out = "";
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { out += esc(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName.toLowerCase();
        if (DROP_TAGS.has(tag)) continue;
        const inner = toXhtml(c);
        if (!KEEP.has(tag)) { out += inner; continue; }
        if (tag === "br" || tag === "hr") { out += "<" + tag + "/>"; continue; }
        const center = /text-align\s*:\s*center/i.test(c.getAttribute("style") || "") || c.getAttribute("align") === "center";
        out += "<" + tag + (center ? ' class="center"' : "") + ">" + inner + "</" + tag + ">";
      }
      return out;
    }

    // ---------------------------------------------------------------- images / cover
    async function fetchBlob(url) {
      const { base64, mime } = await fetchSource(url, "image");
      return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mime });
    }
    // Any image -> small grayscale JPEG (bytes) sized for the reader's screen
    async function toJpeg(blob, maxW, maxH, quality) {
      if (!blob || !blob.size) return null;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white background
      g.filter = "grayscale(1)";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const out = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
      return out ? new Uint8Array(await out.arrayBuffer()) : null;
    }
    // Cover: re-encode to a grayscale JPEG when the browser can; otherwise, if the site
    // already serves a baseline JPEG, keep its bytes as they are.
    async function makeCover(url) {
      if (!url || /noimage|nocover/i.test(url)) return null;
      try {
        const blob = await fetchBlob(url);
        if (!blob || !blob.size) return null;
        if (typeof createImageBitmap === "function") {
          try {
            const dev = await getDevice();
            const bytes = await toJpeg(blob, dev.w, dev.h, 0.8);
            if (bytes && bytes.length) return bytes;
          } catch (e) { log("Cover re-encode skipped (" + e.message + "); using the original image."); }
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes[0] === 0xff && bytes[1] === 0xd8) return bytes; // already JPEG
        log("Cover skipped (couldn't convert it to JPEG here).");
        return null;
      } catch (e) { log("Cover skipped (" + e.message + ")."); return null; }
    }

    // ---------------------------------------------------------------- EPUB building
    // Chapter title styling for CrossInk X3/X4 and standard readers: <h1 class=
    // "chapter-title"> is the FIRST element of each chapter's own spine file, bold and
    // 1.5em, so it renders at the top of page 1 (with embedded CSS on or off).
    const CSS_TEXT =
      "body{margin:0 5%;line-height:1.5}" +
      "h1.chapter-title{font-size:1.5em;font-weight:bold;margin-top:0;margin-bottom:0.85em;" +
      "line-height:1.25;page-break-before:avoid;page-break-after:avoid}" +
      "h2,h3{text-align:center;margin:1em 0 .8em}p{margin:0 0 .7em}" +
      ".center{text-align:center}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.2em .4em}" +
      ".meta{text-align:center;font-size:.9em}img{max-width:100%;height:auto}img.cover{max-height:100%}";

    function page(title, bodyX, extraHead) {
      return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n' +
        "<head><meta charset=\"utf-8\"/><title>" + esc(title) + "</title>" +
        '<link rel="stylesheet" type="text/css" href="style.css"/>' + (extraHead || "") + "</head>\n" +
        "<body>\n" + bodyX + "\n</body>\n</html>\n";
    }
    const chapterPage = (c, bodyX) =>
      page(c.title, '<h1 class="chapter-title"><b>' + esc(c.title) + "</b></h1>\n" +
        '<section epub:type="chapter">\n' + bodyX + "\n</section>");

    async function buildEpub(meta, chapters, coverBytes) {
      const JSZip = globalThis.JSZip;
      const zip = new JSZip();
      const uid = "libread-" + hash(meta.id || meta.title);
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file("META-INF/container.xml",
        '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n');
      zip.file("META-INF/libread.json", JSON.stringify({
        fictionId: meta.id, url: meta.url, title: meta.title, author: meta.author, status: meta.status,
        updated: meta.updated, genres: meta.genres || [], range: meta.range || null,
        chapters: chapters.map((c) => ({ id: c.id, title: c.title, file: c.file })),
      }));
      zip.file("OEBPS/style.css", CSS_TEXT);

      const items = ['<item id="css" href="style.css" media-type="text/css"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'];
      const spine = [];
      if (coverBytes) {
        zip.file("OEBPS/cover.jpg", coverBytes);
        zip.file("OEBPS/cover.xhtml", page("Cover", '<div class="center"><img class="cover" src="cover.jpg" alt="Cover"/></div>'));
        items.push('<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
          '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
        spine.push('<itemref idref="cover"/>');
      }
      zip.file("OEBPS/title.xhtml", page(meta.title,
        "<h1>" + esc(meta.title) + "</h1>" +
        '<p class="meta">by ' + esc(meta.author) + "</p>" +
        '<p class="meta">' + esc(meta.status === "UNKNOWN" ? "" : meta.status) +
        (meta.type ? " \u00B7 " + esc(meta.type) : "") + " \u00B7 " + chapters.length + " chapters \u00B7 updated " +
        esc(String(meta.updated || "").slice(0, 10)) + "</p>" +
        (meta.genres && meta.genres.length ? '<p class="meta">Genres: ' + esc(meta.genres.join(", ")) + "</p>" : "") +
        '<p class="meta">' + esc(meta.url) + "</p><hr/>" + (meta.descriptionX || "")));
      items.push('<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="title"/>');

      chapters.forEach((c, i) => {
        zip.file("OEBPS/" + c.file, c.xhtml);
        items.push('<item id="c' + i + '" href="' + c.file + '" media-type="application/xhtml+xml"/>');
        spine.push('<itemref idref="c' + i + '"/>');
      });

      zip.file("OEBPS/content.opf",
        '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:identifier id="uid">' + esc(uid) + "</dc:identifier>" +
        "<dc:title>" + esc(meta.title) + "</dc:title><dc:creator>" + esc(meta.author) + "</dc:creator>" +
        (meta.genres || []).map((g) => "<dc:subject>" + esc(g) + "</dc:subject>").join("") +
        "<dc:language>en</dc:language><dc:publisher>LibRead</dc:publisher><dc:source>" + esc(meta.url) + "</dc:source>" +
        (meta.descriptionText ? "<dc:description>" + esc(meta.descriptionText) + "</dc:description>" : "") +
        '<meta property="dcterms:modified">' + nowIso() + "</meta>" +
        (coverBytes ? '<meta name="cover" content="cover-img"/>' : "") +
        "</metadata>\n<manifest>" + items.join("") + '</manifest>\n<spine toc="ncx">' + spine.join("") +
        "</spine>\n</package>\n");

      zip.file("OEBPS/nav.xhtml", page("Contents",
        '<nav epub:type="toc" id="toc"><h2>Contents</h2><ol>' +
        chapters.map((c) => '<li><a href="' + c.file + '">' + esc(c.title) + "</a></li>").join("") +
        "</ol></nav>"));
      zip.file("OEBPS/toc.ncx",
        '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
        '<head><meta name="dtb:uid" content="' + esc(uid) + '"/></head><docTitle><text>' + esc(meta.title) +
        "</text></docTitle><navMap>" +
        chapters.map((c, i) => '<navPoint id="n' + i + '" playOrder="' + (i + 1) + '"><navLabel><text>' + esc(c.title) +
          '</text></navLabel><content src="' + c.file + '"/></navPoint>').join("") +
        "</navMap></ncx>\n");

      return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE",
        compressionOptions: { level: 6 } });
    }

    // ---------------------------------------------------------------- library index
    async function loadLibrary() {
      const t = await readSd(ROOT + "/" + LIB_FILE);
      if (!t) return {};
      const lib = JSON.parse(t);
      if (!lib || typeof lib !== "object" || Array.isArray(lib)) throw new Error("Invalid library.json");
      for (const [id, entry] of Object.entries(lib)) {
        if (!entry || novelIdOf(entry.url) !== id || !/^[^./\\][^/\\]*\.epub$/i.test(entry.file || "")) {
          throw new Error("Invalid entry in library.json: " + id);
        }
      }
      return lib;
    }
    async function saveLibrary(lib) {
      await uploadSd(ROOT, LIB_FILE, new Blob([JSON.stringify(lib, null, 1)], { type: "application/json" }));
    }

    // ---------------------------------------------------------------- the main job
    // opts: { fresh: re-download everything, range: {from, to} or null }
    async function sync(url, opts) {
      opts = opts || {};
      const id = novelIdOf(url);
      if (!id) throw new Error("Not a libread.com novel link: " + url);
      const lib = await loadLibrary();
      const prev = lib[id] || {};
      const bookDir = ROOT;
      await ensureRoot();
      const range = opts.range || prev.range || null;

      // What we already have: read it from the existing EPUB
      const have = new Map();
      let coverBytes = null;
      if (prev.file) {
        const old = await readSd(bookDir + "/" + prev.file, "blob");
        if (old) {
          try {
            const JSZip = globalThis.JSZip;
            const z = await JSZip.loadAsync(old);
            const info = JSON.parse(await z.file("META-INF/libread.json").async("string"));
            const cov = z.file("OEBPS/cover.jpg");
            if (!opts.fresh) {
              for (const c of info.chapters) {
                const f = z.file("OEBPS/" + c.file);
                if (f) have.set(c.id, { id: c.id, title: c.title, file: c.file, xhtml: await f.async("string") });
              }
              if (cov) coverBytes = await cov.async("uint8array");
              log("Existing EPUB has " + have.size + " chapters.");
            }
          } catch (e) {
            log("Existing EPUB could not be read, rebuilding it (" + e.message + ")");
            have.clear();
          }
        }
      }

      log("Reading the novel page\u2026");
      const fic = await getFiction(novelUrlOf(url) || url);
      setStatus(fic.title + " \u2014 " + fic.status + ", " + fic.total + " chapters online");

      // Chapter range: one given now wins, else the one remembered for this novel, else all.
      // "to" left empty means "up to the latest", so later updates keep adding new chapters.
      const from = range ? Math.max(1, range.from || 1) : 1;
      const to = range && range.to ? Math.min(range.to, fic.chapters.length) : fic.chapters.length;
      if (from > fic.chapters.length) throw new Error("This novel only has " + fic.chapters.length + " chapters.");
      if (to < from) throw new Error("Chapter range " + from + "\u2013" + to + " is empty.");
      const wanted = fic.chapters.slice(from - 1, to);
      if (range) log("Chapter range: " + from + "\u2013" + (range.to ? to : "latest") + " (" + wanted.length + " chapters)");

      // Use a bounded ASCII name so CrossInk's filename sanitizer won't truncate it.
      const stem = safeName(fic.title).replace(/[^a-z0-9 _-]+/gi, "").trim().slice(0, 70) || "Novel";
      const file = prev.file || stem + "-" + hash(id) + ".epub";
      if (!coverBytes) coverBytes = await makeCover(fic.coverUrl);

      const entry = (count) => ({
        title: fic.title, author: fic.author, url: fic.url, file, dir: bookDir, source: "libread",
        status: fic.status, chapters: count, online: fic.total, genres: fic.genres, coverUrl: fic.coverUrl,
        range, checked: nowIso(), ids: [...have.keys()], newCount: wanted.filter((c) => !have.has(c.id)).length,
      });

      const missing = wanted.filter((c) => !have.has(c.id));
      if (!missing.length) {
        log("Up to date \u2014 " + have.size + " chapters in the book.");
        lib[id] = entry(have.size);
        await saveLibrary(lib);
        return { added: 0, total: have.size };
      }
      log(missing.length + " chapter(s) to download.");

      const save = async (final) => {
        // Keep the site's order; chapters the author deleted online stay at the end.
        const ordered = fic.chapters.filter((c) => have.has(c.id)).map((c) => have.get(c.id));
        const online = new Set(fic.chapters.map((c) => c.id));
        for (const c of have.values()) if (!online.has(c.id)) ordered.push(c);
        const meta = Object.assign({}, fic, { updated: nowIso(), range });
        log((final ? "Building" : "Saving progress:") + " EPUB with " + ordered.length + " chapters\u2026");
        const blob = await buildEpub(meta, ordered, coverBytes);
        log("Sending " + Math.round(blob.size / 1024) + " KB to the reader…");
        await uploadSd(bookDir, file, blob);
        lib[id] = entry(ordered.length);
        await saveLibrary(lib);
      };

      let added = 0, fetchedAny = false;
      for (let i = 0; i < missing.length; i++) {
        const c = missing[i];
        if (stopRequested) { log("Stopped."); break; }
        setStatus("Chapter " + (i + 1) + "/" + missing.length + ": " + c.title);
        let bodyX = null;
        for (let attempt = 1; attempt <= 3 && bodyX == null; attempt++) {
          try {
            if (fetchedAny) await sleep(DELAY_MS); // be polite between chapter requests
            const doc = await fetchDoc(c.url);
            bodyX = await parseChapter(doc);
            fetchedAny = true;
          } catch (e) {
            if (stopRequested) break;
            if (attempt === 3) throw new Error("Chapter \"" + c.title + "\": " + e.message);
            log("Retrying \"" + c.title + "\" (" + e.message + ")");
            await sleep(DELAY_MS * 3 * attempt);
          }
        }
        if (bodyX == null) break;
        const fileName = "ch-" + hash(c.id) + ".xhtml";
        have.set(c.id, { id: c.id, title: c.title, file: fileName, xhtml: chapterPage(c, bodyX) });
        added++;
        if (added % CHECKPOINT_EVERY === 0 && i < missing.length - 1) await save(false);
      }
      if (added) await save(true);
      log("Done: " + added + " new chapter(s), " + have.size + " in the book \u2192 " + bookDir + "/" + file);
      return { added, total: have.size };
    }

    // ------------------------------------------------------------ UI
    const LISTS = [["latest", "Latest Release"], ["completed", "Completed"], ["popular", "Most Popular"],
      ["english", "English Novels"], ["chinese", "Chinese Novels"], ["korean", "Korean Novels"],
      ["japanese", "Japanese Novels"]];
    const LIST_URL = {
      latest: "/sort/latest-release-novel",
      completed: "/sort/completed-novel",
      popular: "/most-popular",
      english: "/sort/latest-release/english-novel",
      chinese: "/sort/latest-release/chinese-novel",
      korean: "/sort/latest-release/korean-novel",
      japanese: "/sort/latest-release/japanese-novel",
    };
    const GENRES = [["", "All genres"], "Action", "Adult", "Adventure", "Comedy", "Drama", "Eastern", "Ecchi",
      "Fantasy", "Game", "Gender Bender", "Harem", "Historical", "Horror", "Josei", "Martial Arts", "Mature",
      "Mecha", "Mystery", "Psychological", "Reincarnation", "Romance", "School Life", "Sci-fi", "Seinen",
      "Shoujo", "Shounen Ai", "Shounen", "Slice of Life", "Smut", "Sports", "Supernatural", "Tragedy", "Wuxia",
      "Xianxia", "Xuanhuan", "Yaoi"].map((g) => (Array.isArray(g) ? g : [g, g]));
    const opt = (pairs) => pairs.map(([v, t]) => '<option value="' + v + '">' + t + "</option>").join("");

    container.innerHTML =
      "<style>.lr{max-width:900px;margin:16px auto;padding:16px;color:#202124;background:#fff;border:1px solid #bbb;border-radius:8px;font:16px system-ui}.lr input{width:100%;box-sizing:border-box;padding:8px;margin:4px 0}.lr button{padding:6px 10px;margin:2px 4px 2px 0}" +
      ".lr .card{border:1px solid #8884;border-radius:6px;padding:8px;margin:8px 0}.lr .muted{opacity:.7;font-size:.9em}" +
      ".lr pre{white-space:pre-wrap;max-height:160px;overflow:auto;font-size:.85em;background:#8881;padding:6px;margin:4px 0}" +
      ".lr .blurb{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}" +
      ".lr .opts input[type=number]{width:5.5em;display:inline-block;margin:4px 2px}.lr .opts label{display:block;margin:4px 0}" +
      ".lr select{padding:6px;margin:3px 4px 3px 0;max-width:100%}.lr .browse{margin:6px 0}" +
      ".lr .card::after{content:'';display:block;clear:both}" +
      ".lr img.cover{float:left;width:64px;height:96px;object-fit:cover;border-radius:4px;margin:0 10px 4px 0;background:#8882}" +
      ".lr .new{font-weight:bold}.lr #lr-status{font-weight:bold;opacity:1}" +
      ".lr .blurb.open{display:block;-webkit-line-clamp:unset;overflow:visible}</style>" +
      "<h2>LibRead Web Novels</h2>" +
      '<input id="lr-q" placeholder="Search a title, or paste a libread.com novel link"/>' +
      '<button id="lr-go">Search</button><button id="lr-stop">Stop</button>' +
      '<div class="browse" id="lr-browsebox">Browse <select id="lr-list">' + opt(LISTS) + "</select>" +
      '<select id="lr-genre">' + opt(GENRES) + '</select><button id="lr-browse">Browse</button></div>' +
      '<div class="opts">Chapters <input id="lr-from" type="number" min="1" placeholder="from"/>' +
      ' to <input id="lr-to" type="number" min="1" placeholder="latest"/>' +
      '<div class="muted">Leave the range empty for the whole novel, or what you set before. ' +
      'An empty "to" keeps adding new chapters.</div></div>' +
      '<p id="lr-status" class="muted"></p><pre id="lr-log"></pre>' +
      '<div id="lr-res"></div><button id="lr-more" style="display:none">Show more</button>' +
      "<h3>My novels</h3><div id=\"lr-lib\" class=\"muted\">Loading\u2026</div>" +
      '<button id="lr-check">Check all</button><button id="lr-all">Update all</button>' +
      '<p class="muted">Keep this page open and the reader awake while it works.</p>';

    const $ = (id) => container.querySelector("#" + id);
    const log = (m) => { const el = $("lr-log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };
    const setStatus = (m) => { $("lr-status").textContent = m; };
    let busy = false;
    let stopRequested = false;

    function readRange() {
      const f = parseInt($("lr-from").value, 10), t = parseInt($("lr-to").value, 10);
      if (!f && !t) return null;
      return { from: f > 0 ? f : 1, to: t > 0 ? t : null };
    }
    const options = () => ({ range: readRange() });
    try { const v = localStorage.getItem("lr-range"); if (v) { const r = JSON.parse(v); if (r && (r.from || r.to)) { $("lr-from").value = r.from || ""; $("lr-to").value = r.to || ""; } } } catch (e) { /* ignore */ }
    $("lr-from").onchange = $("lr-to").onchange = () => {
      try { localStorage.setItem("lr-range", JSON.stringify(readRange())); } catch (e) { /* ignore */ }
    };

    async function job(fn) {
      if (busy) return log("Already working \u2014 wait or press Stop.");
      busy = true; stopRequested = false;
      let lock = null;
      try { lock = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (e) { /* optional */ }
      try { await fn(); }
      catch (e) { log("Error: " + e.message); setStatus("Failed \u2014 see log."); }
      finally {
        if (lock) { try { lock.release().catch(() => {}); } catch (e) { /* ignore */ } }
        busy = false;
        renderLibrary();
      }
    }

    function card(f, inLib) {
      const d = document.createElement("div");
      d.className = "card";
      const badge = inLib && inLib.newCount != null
        ? (inLib.newCount > 0 ? ' \u00B7 <span class="new">' + esc(inLib.newCount) + " new</span>" : " \u00B7 up to date") : "";
      d.innerHTML =
        "<b>" + esc(f.title) + "</b>" + (f.author ? ' <span class="muted">by ' + esc(f.author) + "</span>" : "") +
        '<div class="muted">' + esc(f.status && f.status !== "UNKNOWN" ? f.status : "") +
        (f.chapters != null ? " \u00B7 " + esc(f.chapters) + " chapters" : "") +
        (inLib && inLib.chapters != null ? " \u00B7 you have " + esc(inLib.chapters) + (inLib.online ? " of " + esc(inLib.online) : "") : "") +
        (inLib && inLib.range ? " \u00B7 range " + esc((inLib.range.from || 1)) + "\u2013" + esc((inLib.range.to || "latest")) : "") +
        badge + "</div>" +
        (f.genres && f.genres.length ? '<div class="muted">' + esc(f.genres.join(" \u00B7 ")) + "</div>" : "") +
        (f.blurb ? '<div class="blurb" title="Tap to expand">' + esc(f.blurb) + (f.blurb.length >= 400 ? "\u2026" : "") + "</div>" : "");
      const bl = d.querySelector(".blurb");
      if (bl) bl.onclick = () => bl.classList.toggle("open");
      const b = document.createElement("button");
      b.textContent = inLib ? "Update" : "Download";
      b.onclick = () => { showProgress(); job(() => sync(f.url, options())); };
      d.appendChild(b);
      if (inLib) {
        const r = document.createElement("button");
        r.textContent = "Re-download all";
        r.onclick = () => { if (confirm("Download every chapter again?")) job(() => sync(f.url, Object.assign(options(), { fresh: true }))); };
        d.appendChild(r);
      }
      return d;
    }

    async function renderLibrary() {
      const box = $("lr-lib");
      let lib;
      try { lib = await loadLibrary(); }
      catch (e) { box.textContent = e.message; return; }
      box.innerHTML = "";
      const ids = Object.keys(lib);
      if (!ids.length) { box.textContent = "Nothing downloaded yet."; return; }
      ids.sort((a, b) => String(lib[a].title).localeCompare(String(lib[b].title)))
        .forEach((id) => box.appendChild(card(Object.assign({ id }, lib[id], { chapters: null }), lib[id])));
    }

    // ---- results (search or browse): 8 at a time
    const PAGE = 8;
    let results = [], shown = 0;
    function showResults(list, label, lib) {
      results = list; shown = 0;
      $("lr-res").innerHTML = "";
      $("lr-more").style.display = "none";
      setStatus(list.length ? label + " \u2014 " + list.length + " result(s)" : "Nothing found.");
      fillResults(lib);
    }
    function fillResults(lib) {
      const res = $("lr-res");
      results.slice(shown, shown + PAGE).forEach((f) => res.appendChild(card(f, lib && lib[f.id])));
      shown = Math.min(results.length, shown + PAGE);
      const more = $("lr-more");
      more.style.display = shown < results.length ? "" : "none";
      more.textContent = shown < results.length ? "Show more (" + (results.length - shown) + " ready)" : "Show more";
    }
    $("lr-more").onclick = () => job(async () => fillResults(await loadLibrary()));

    $("lr-go").onclick = () => job(async () => {
      const q = $("lr-q").value.trim();
      if (!q) return;
      const novelUrl = novelUrlOf(q);
      if (novelUrl) {
        setStatus("Opening the novel page\u2026");
        const lib = await loadLibrary();
        const f = await getFiction(novelUrl);
        showResults([{
          id: f.id, url: f.url, title: f.title, author: f.author, status: f.status,
          chapters: f.total, genres: f.genres, coverUrl: f.coverUrl, blurb: (f.descriptionText || "").slice(0, 400),
        }], f.title, lib);
        return;
      }
      if (/libread\.com\/libread\//i.test(q)) throw new Error("That doesn't look like a libread.com novel link.");
      setStatus("Searching for \u201C" + q + "\u201D\u2026");
      const doc = await fetchDoc(SITE + "/search?searchkey=" + encodeURIComponent(q));
      const lib = await loadLibrary();
      showResults(parseCards(doc), "Results for \u201C" + q + "\u201D", lib);
    });
    $("lr-q").addEventListener("keydown", (e) => { if (e.key === "Enter") $("lr-go").click(); });

    $("lr-browse").onclick = () => job(async () => {
      const list = $("lr-list").value, genre = $("lr-genre").value;
      let base, name;
      if (genre) {
        base = SITE + "/genre/" + genre.replace(/ /g, "+");
        name = "Genre: " + genre;
      } else {
        base = SITE + LIST_URL[list];
        name = (LISTS.find((l) => l[0] === list) || [])[1] || "Browse";
      }
      setStatus(name + "\u2026");
      const doc = await fetchDoc(base); // page 1; "Show more" only slices what we fetched
      const lib = await loadLibrary();
      showResults(parseCards(doc), name, lib);
      if (results.length) log(name + ": " + results.length + " novel(s) on page 1. Paste a link for the rest.");
    });

    function showProgress() {
      try { $("lr-status").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { /* ignore */ }
    }

    // ---- check for new chapters without downloading anything
    async function checkAll() {
      const lib = await loadLibrary();
      const ids = Object.keys(lib);
      if (!ids.length) return log("Nothing to check.");
      let total = 0, withNew = 0;
      for (const id of ids) {
        if (stopRequested) { log("Stopped."); break; }
        const e = lib[id];
        setStatus("Checking " + e.title + "\u2026");
        try {
          const have = Array.isArray(e.ids) ? new Set(e.ids) : null;
          const fic = await getFiction(e.url);
          const wanted = e.range
            ? fic.chapters.slice(Math.max(1, e.range.from || 1) - 1, e.range.to ? Math.min(e.range.to, fic.chapters.length) : fic.chapters.length)
            : fic.chapters;
          const n = have ? wanted.filter((c) => !have.has(c.id)).length : Math.max(0, wanted.length - (e.chapters || 0));
          Object.assign(e, { status: fic.status, online: fic.total, newCount: n, checked: nowIso() });
          total += n; if (n) withNew++;
          log(e.title + ": " + (n ? n + " new" : "up to date"));
        } catch (err) { log(e.title + ": " + err.message); }
        await sleep(DELAY_MS);
      }
      await saveLibrary(lib);
      setStatus("Check finished: " + total + " new chapter(s) in " + withNew + " novel(s).");
      return { total, withNew };
    }
    $("lr-check").onclick = () => showProgress() || job(checkAll);

    async function updateAll() {
      const lib = await loadLibrary();
      const ids = Object.keys(lib);
      if (!ids.length) return log("Nothing to update.");
      let total = 0;
      for (const id of ids) {
        if (stopRequested) break;
        const e = lib[id];
        log("\u2014 " + e.title);
        try { total += (await sync(e.url, { range: e.range })).added; }
        catch (err) { log("Error: " + err.message); }
      }
      setStatus("Update all finished: " + total + " new chapter(s).");
    }
    $("lr-all").onclick = () => showProgress() || job(updateAll);
    $("lr-stop").onclick = () => { if (busy) { stopRequested = true; log("Stopping\u2026"); } };

    renderLibrary();
  }
  start();
})();
