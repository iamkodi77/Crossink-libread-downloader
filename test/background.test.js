const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { join } = require('node:path');

function worker(fetch) {
  let receive, rules;
  const chrome = {
    runtime: { id: 'extension-id', onMessage: { addListener(fn) { receive = fn; } } },
    action: { onClicked: { addListener() {} } },
    declarativeNetRequest: { async updateSessionRules(update) { rules = update.addRules; } },
  };
  runInNewContext(readFileSync(join(__dirname, '../extension/background.js'), 'utf8'), {
    chrome, fetch, URL, AbortSignal, TextDecoder, btoa, console,
  });
  return {
    rules: () => rules,
    send(url, kind = 'text') {
      return new Promise((resolve) => {
        assert.equal(receive({ type: 'libread-fetch', url, kind }, { id: chrome.runtime.id, tab: {} }, resolve), true);
      });
    },
  };
}

function mockResponse(finalUrl, bytes, contentType = 'text/html') {
  const r = new Response(bytes, { headers: { 'Content-Type': contentType } });
  Object.defineProperty(r, 'url', { value: finalUrl });
  return r;
}

test('worker only requests supported origins and returns the final chapter URL', async () => {
  let calls = 0;
  const chapter = 'https://freewebnovel.com/novel/test/chapter-1';
  const w = worker(async (_, init) => {
    calls++;
    assert.equal(init.credentials, 'omit');
    return mockResponse(chapter, 'chapter body');
  });
  for (const bad of ['https://libread.com.evil.test/a', 'http://libread.com', 'https://u@libread.com/', 'https://libread.com:8080/', 'file:///etc/passwd']) {
    assert.equal((await w.send(bad)).ok, false);
  }
  assert.equal(calls, 0);
  const response = await w.send('https://libread.com/libread/test-123/chapter-1');
  assert.equal(response.ok, true);
  assert.equal(response.finalUrl, chapter);
  assert.equal(response.text, 'chapter body');
  const [block, allow] = w.rules();
  assert.equal(block.action.type, 'block');
  assert.ok(allow.priority > block.priority);
  assert.ok(new RegExp(allow.condition.regexFilter).test(chapter));
  assert.ok(!new RegExp(allow.condition.regexFilter).test('http://192.168.1.2/'));
});

test('worker rejects invalid cover content, oversized responses, and unexpected final URLs', async () => {
  const url = 'https://libread.com/a';
  assert.match((await worker(async () => mockResponse(url, 'html')).send(url, 'image')).error, /cover image type/);
  assert.match((await worker(async () => mockResponse(url, new Uint8Array(4 * 1024 * 1024 + 1))).send(url)).error, /4 MiB/);
  assert.equal((await worker(async () => mockResponse('https://other.test/', 'body')).send(url)).ok, false);
  const image = await worker(async () => mockResponse(url, Uint8Array.of(0xff, 0xd8), 'image/jpeg')).send(url, 'image');
  assert.equal(image.base64, '/9g=');
});
