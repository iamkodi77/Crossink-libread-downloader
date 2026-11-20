# LibRead for CrossInk

Search or browse LibRead, download a chapter range as an EPUB, and append new chapters to an existing book on your Xteink reader. This ports the [original CrossPoint plugin](https://github.com/mrcloudworks-glitch/webnovel-downloader-for-crosspoint) to the **CrossInk File Transfer web interface**.

CrossInk v1.6.1 does not provide CrossPoint's SD-card plugin loader or its fetch/relay API. This port is an **unpacked Chrome/Chromium extension**, not a folder to copy onto the SD card. It requires no firmware rebuild or companion server.

## Install and use

1. Download or clone this repository. In Chrome or Chromium (106+), open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select this repository's `extension/` folder.
2. On the reader, start **File Transfer**. Open the address shown on the reader in the same browser. The computer must be able to reach the reader and the internet at the same time. If the reader's hotspot leaves the computer offline, connect both devices to a shared Wi-Fi network instead.
3. Click **LibRead for CrossInk** in the browser toolbar or Extensions menu. A LibRead panel appears on the current reader page. After refreshing or navigating, click the extension again.
4. Search by title, paste a `https://libread.com/libread/…` novel URL, or browse a list. Optionally set **Chapters** (for example, `1` to `5`) and click **Download**. Leave the upper bound empty to include subsequent chapters in future updates.
5. Find the finished book in `/LibRead` on the SD card. Use **Update** or **Update all** to fetch missing chapters; **Check all** checks for new chapters without downloading chapter text.

## Compatibility and limitations

- The integration targets the [CrossInk v1.6.1 webserver](https://github.com/uxjulia/CrossInk/blob/v1.6.1/src/network/CrossPointWebServer.cpp). The browser fetches pages from LibRead and its FreeWebNovel chapter redirects, builds the EPUB, and writes it through CrossInk's built-in file endpoints. The reader does not need to reach the source sites itself.
- Keep one LibRead tab active and the reader in File Transfer while saving. Updates replace the EPUB; reading position and highlights are **not guaranteed to carry over**. Back up important books and reading state before updating.
- Updates stage a new file before replacing the old one. If File Transfer disconnects during the rename, check `/LibRead` for `libread-backup-*` (the previous file) and `libread-new-*` (the staged file) before attempting another update.
- Source layout changes, rate limits, and bot checks can prevent downloads. The extension does not solve challenges. Download only works you have permission to download.

## Development

```sh
npm ci --prefix test
npm test --prefix test
```

Tests use local fixtures and mock the reader endpoints; they check the EPUB output, incremental updates, and the worker's request restrictions. They do not require the source sites or test on physical hardware.

Adapted from [CrossPoint LibRead at `8c8f228`](https://github.com/mrcloudworks-glitch/webnovel-downloader-for-crosspoint/tree/8c8f228006ff7a2a437673be8606f1c98a767b4b), under the [MIT license](LICENSE). Bundled JSZip and pako notices are in `extension/vendor/`.
