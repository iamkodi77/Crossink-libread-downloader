"use strict";

const SOURCE_HOSTS = ["libread.com", "freewebnovel.com"];
const MAX_BYTES = 4 * 1024 * 1024;

function sourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !SOURCE_HOSTS.includes(url.hostname) ||
      url.username || url.password || url.port) {
    throw new Error("Only HTTPS LibRead and FreeWebNovel URLs are supported");
  }
  return url.href;
}

let sourceRules;
function restrictRedirects() {
  // Scope the network rules to this extension, including redirected requests.
  const condition = { initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest"] };
  if (!sourceRules) {
    sourceRules = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1, 2],
      addRules: [
        { id: 1, priority: 1, action: { type: "block" }, condition },
        { id: 2, priority: 2, action: { type: "allow" }, condition: {
          ...condition, regexFilter: "^https://(libread\\.com|freewebnovel\\.com)/",
        } },
      ],
    }).catch((e) => { sourceRules = null; throw e; });
  }
  return sourceRules;
}

async function downloadSource(message) {
  const url = sourceUrl(message.url);
  if (message.kind !== "text" && message.kind !== "image") throw new Error("Invalid request type");
  await restrictRedirects();
  const response = await fetch(url, {
    credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(25000),
  });
  const finalUrl = sourceUrl(response.url);
  if (!response.ok) throw new Error("Source returned HTTP " + response.status);
  const mime = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (message.kind === "image" && !/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) {
    throw new Error("Unsupported cover image type");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Source response exceeds 4 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (message.kind === "text") return { ok: true, finalUrl, text: new TextDecoder().decode(bytes) };
  let binary = "";
  for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ok: true, finalUrl, mime, base64: btoa(binary) };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || message?.type !== "libread-fetch") return;
  downloadSource(message).then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:\/\//.test(tab.url || "")) return;
  const target = { tabId: tab.id };
  try {
    const [{ result, documentId }] = await chrome.scripting.executeScript({ target, func: async () => {
      try {
        const r = await fetch("/api/status", { redirect: "error", signal: AbortSignal.timeout(3500) });
        const status = r.ok && await r.json();
        if (status && typeof status.version === "string" && typeof status.device === "string" &&
            typeof status.freeHeap === "number" && ["STA", "AP"].includes(status.mode)) return true;
      } catch (_) { /* not a reachable reader */ }
      alert("Open your CrossInk reader's File Transfer page, then click LibRead again.");
      return false;
    } });
    if (result) await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [documentId] }, files: ["vendor/jszip.min.js", "plugin.js"],
    });
  } catch (error) {
    console.warn("Could not open LibRead:", error);
  }
});
