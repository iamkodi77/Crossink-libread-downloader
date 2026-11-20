const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const script = (path) => readFileSync(new URL(`../extension/${path}`, `file://${__filename}`), 'utf8');

const novel = 'https://libread.com/libread/test-novel-123';
const links = (n) => Array.from({ length: n }, (_, i) =>
  `<li><a href="${novel}/chapter-${i + 1}">Chapter ${i + 1}</a></li>`).join('');

test('search, generate EPUB, and append only missing chapters using CrossInk endpoints', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://reader.local/files', runScripts: 'outside-only' });
  const w = dom.window;
  w.setImmediate = setImmediate;
  try {
    const files = new Map();
    const chapters = [];
    let count = 1;
    w.fetch = async (raw, init = {}) => {
      const u = new URL(raw, w.location.href);
      assert.equal(u.origin, w.location.origin);
      const path = u.searchParams.get('path');
      const blobResponse = (blob) => ({ ok: true, status: 200, blob: async () => blob, text: async () => {
        const f = new w.FileReader();
        return new Promise((resolve, reject) => { f.onload = () => resolve(f.result); f.onerror = reject; f.readAsText(blob); });
      } });
      const response = (status, text = '') => ({ ok: status === 200, status, text: async () => text });
      switch (u.pathname) {
        case '/download': return files.has(path) ? blobResponse(files.get(path)) : response(404);
        case '/mkdir': assert.equal(init.body.get('name'), 'LibRead'); return response(200);
        case '/upload': {
          const file = init.body.get('file');
          const key = path + '/' + file.name;
          if (files.has(key)) return response(400, 'File already exists');
          files.set(key, file); return response(200);
        }
        case '/rename': {
          const from = init.body.get('path');
          if (!files.has(from)) return response(404);
          const to = '/LibRead/' + init.body.get('name');
          assert.equal(from.split('.').pop(), to.split('.').pop());
          if (files.has(to)) return response(409);
          files.set(to, files.get(from)); files.delete(from); return response(200);
        }
        case '/delete': files.delete(init.body.get('path')); return response(200);
        default: throw new Error('Unexpected firmware endpoint: ' + u.pathname);
      }
    };
    w.chrome = { runtime: { sendMessage: async ({ type, url, kind }) => {
      assert.equal(type, 'libread-fetch'); assert.equal(kind, 'text');
      const u = new URL(url);
      if (u.pathname === '/search') return { ok: true, finalUrl: url, text: `<div class="col-content"><div class="con"><h3><a href="${novel}">Test Novel</a></h3></div></div>` };
      if (u.searchParams.has('ajax')) return { ok: true, finalUrl: url, text: JSON.stringify({ code: 200, html: links(count), totalChapters: count, totalPage: 1 }) };
      if (url === novel) return { ok: true, finalUrl: url, text: `<h1 class="tit">Test Novel</h1><ul id="idData">${links(count)}</ul>` };
      chapters.push(url);
      return { ok: true, finalUrl: url.replace('libread.com', 'freewebnovel.com'), text: `<div id="article"><p>Fixture text ${chapters.length}.</p><script>bad()</script></div>` };
    } } };
    w.eval(script('vendor/jszip.min.js'));
    w.eval(script('plugin.js'));
    w.eval(script('plugin.js'));
    assert.equal(w.document.querySelectorAll('#crossink-libread').length, 1);
    const panel = w.document.querySelector('#crossink-libread').shadowRoot;
    const $ = (sel) => panel.querySelector(sel);
    async function until(fn) {
      for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.fail($('#lr-log').textContent || 'Panel did not reach expected state');
    }
    $('#lr-q').value = 'Test Novel';
    await $('#lr-go').onclick();
    assert.match($('#lr-res').textContent, /Test Novel/);
    $('#lr-res button').click();
    await until(() => /you have 1/.test($('#lr-lib').textContent));
    count = 2;
    $('#lr-lib button').click();
    await until(() => /you have 2/.test($('#lr-lib').textContent));
    assert.deepEqual(chapters, [novel + '/chapter-1', novel + '/chapter-2']);
    assert.equal(files.size, 2, 'only the book and index remain after replacement');
    const epub = [...files].find(([name]) => name.endsWith('.epub'))[1];
    const zip = await w.JSZip.loadAsync(epub);
    assert.equal(await zip.file('mimetype').async('string'), 'application/epub+zip');
    const meta = JSON.parse(await zip.file('META-INF/libread.json').async('string'));
    assert.deepEqual(meta.chapters.map((ch) => ch.id), ['1', '2']);
    assert.match(await zip.file('OEBPS/' + meta.chapters[0].file).async('string'), /Fixture text 1\./);
    assert.doesNotMatch(await zip.file('OEBPS/' + meta.chapters[1].file).async('string'), /bad\(\)/);
  } finally { w.close(); }
});
