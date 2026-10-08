# VectorCraft: unofficial browser experience

Try it at https://wavjaby.github.io/vectorcraft-web/. Original project: https://github.com/storytold/vectorcraft. Official desktop downloads: https://github.com/storytold/vectorcraft/releases/latest.

VectorCraft is made by the ArtCraft Team and contributors. This independent community mirror makes the official v0.6.0 browser build easier to try without installation; it is not operated or endorsed by them. All original application files remain byte-for-byte unchanged.

## Hosting and delivery

Run `node scripts/build-site.cjs` for a dry run, or add `--write` to create `_site/`. The builder verifies original release files against `upstream-files.json`, restores ignored Wasm from the pinned archive, compresses it with gzip, splits it into content-addressed 512 KiB parts and checks exact reconstruction. Wasm and generated parts stay outside Git. Four bounded requests feed streaming decompression; SHA-256 verification gates completion and local caching. More concurrency is not guaranteed to improve shared CDN throughput.

The host adds download progress, original/download links, a collapsible toolbar, transparent credits and a dismissible notice. English is the default; any first preferred browser language beginning with `zh` selects Traditional Chinese. Preferences persist locally when storage is allowed. Editor code and language behavior remain official. The shell uses the upstream MediumDark palette from `crates/ui-egui/src/theme.rs:Tokens::for_brightness`; changing the editor theme does not change the shell.

Below 900 CSS pixels, the editor fits a 960-pixel virtual viewport; 50%/75%/100% overrides persist. Landscape works best. This adjusts display scale, not touch support. `?webgl` forwards the official flag to force WebGL2 instead of WebGPU. Readiness requires an initialized canvas and removal of the official loading element after `WebRunner.start` succeeds.

## Browser differences

The default backend selection tries WebGPU where available. A reported GPU startup error retries the unchanged application once with `?webgl`; an explicit `?webgl` override disables that retry. Download errors, slow startup and failures after editing starts never trigger a backend reload. WebGL2 is a compatibility backend, not a guaranteed speed improvement; document rasterization remains on the CPU.

Static/configuration evidence from tagged v0.6.0 source; no claim of exhaustive feature parity:

| Area | Browser behavior | Source |
|---|---|---|
| File access | Open/Place use async pickers and drag/drop; Save/Export download new files instead of overwriting originals | `apps/vectorcraft-web/src/web.rs:services`, `download`; `crates/ui-egui/src/io.rs` |
| Recovery | BrowserStore uses local storage; quota, private browsing and clearing data can prevent recovery | `apps/vectorcraft-web/src/web.rs:BrowserStore` |
| Rendering/integration | WebGPU or WebGL2; no desktop TCP control server; heavy work shares browser limits | `apps/vectorcraft-web/src/main.rs`; `crates/ui-egui/src/background.rs`, `render_worker.rs` |
| Fonts | No automatic access to installed system fonts; bundled or explicitly loaded fonts determine glyph coverage | `crates/ui-egui/src/ui_fonts.rs`; `crates/ui-egui/src/panels/character.rs` |
| Printing | Browser print dialog selects printers, rather than desktop spooler integration | `apps/vectorcraft-web/src/web.rs:BrowserPrint` |

Download saves explicitly and keep backups. Browser limits do not imply identical desktop limits. VectorCraft itself remains alpha; evaluate the official desktop app separately for production work.

## Provenance and licenses

Official release: https://github.com/storytold/vectorcraft/releases/tag/v0.6.0. `upstream-files.json` records archive provenance and original file hashes; every build checks them. Compression/splitting restores the exact original bytes. This establishes consistency with the published release, not an independent author-signature chain.

VectorCraft is MIT OR Apache-2.0; retain LICENSE-MIT, LICENSE-APACHE, [NOTICE](app/NOTICE), [ASSETS.md](app/ASSETS.md) and accompanying asset licenses. Independent host code adapted from the PhotoCraft/PrintCraft community mirrors is MIT. ArtCraft marks have [separate terms](app/docs/brand/LICENSE-brand.txt); the host uses plain text attribution and no extracted logos. No complete transitive dependency-license audit is claimed.

`node --test tests/*.test.cjs` runs unit/selftest gates for delivery, failures, integrity, caching and provenance. Actual browser startup/import/save and mobile checks are separate runtime evidence.

## Single-page hosting and updates

The community bootstrap in `app-loader.js` mounts the official canvas in the main document; no iframe is created. Original JS/Wasm are verified against `upstream-files.json`. The host, loader and layout are community code, not an official build or endorsement. Keep upstream copyright, licenses, NOTICE and third-party attributions; do not extract ArtCraft brand marks into the host.

Wasm and compressed parts are ignored. CI downloads the exact archive pinned by URL + SHA-256, restores the verified Wasm, generates a fresh Pages artifact, and deploys it without committing binaries. Browser asset caches retire prior Wasm hashes on service-worker activation. Existing Git history is not rewritten by this change.

1. Select an explicit official web ZIP and verify its published SHA-256; never silently follow latest.
2. Run `node scripts/update-upstream.cjs --archive HTTPS_ZIP_URL --sha256 SHA256 --version VERSION` to inspect the update, then repeat with `--write`. The command rejects changed archive/bootstrap contracts; review upstream licensing, supplemental notices and web/desktop differences.
3. Run `node scripts/build-site.cjs --output _site-review --write` and `node --test tests/*.test.cjs`; perform fresh-browser import/edit/export, mobile and renderer-failure checks.
4. Commit only source, configuration and provenance metadata, then push. Pages builds its current version from scratch; neither the old nor the new Wasm/parts enter Git.

For a clean checkout, `node scripts/update-upstream.cjs --restore` restores only the pinned Wasm. `--restore --archive LOCAL_ZIP` accepts a local copy with the same pinned archive hash.
