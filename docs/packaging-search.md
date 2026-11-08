# Packaged Search Runtime

`build-resources/search/soma-search/` is a PyInstaller one-directory distribution for macOS Apple Silicon. It embeds Python 3.14, SearXNG source and engine modules, templates/static assets, engine data, native Python extensions, and their shared libraries. Runtime startup does not invoke Python, Homebrew, or source-tree paths.

The executable is `soma-search/soma-search`. Its adjacent `_internal/` directory is part of the distribution and must remain alongside the executable. The app should launch it as a long-lived child process and keep its piped stdin open. Set `SOMA_EXIT_ON_STDIN_CLOSE=1` so the runtime exits on parent shutdown.

Environment contract:

- `SEARXNG_BIND_ADDRESS=127.0.0.1`
- `SEARXNG_PORT` or `SOMA_SEARXNG_PORT` for the chosen loopback port (default `8888`)
- `SEARXNG_SETTINGS_PATH` may point to the installed app's `settings.yml`; otherwise the bundled Soma settings are used
- `SOMA_SEARXNG_PROXY` accepts `auto` (default), `direct`, or a proxy URL; auto uses environment proxy, macOS manual proxy, then validated local proxy discovery

For reproducible builds on macOS arm64, ensure `.searxng/venv` exists and install PyInstaller in that environment, then run:

```sh
python3 scripts/package-search.py
```

The build script verifies the host and output architecture. PyInstaller ad-hoc signs the executable and its bundled native libraries; the containing app still needs its normal release signing/notarization step.

Verification performed on an isolated environment (`env -i`, working directory `/tmp`, no `PYTHONPATH`): `/healthz` returned `OK`; a `/search?q=packaged%20runtime&format=json` request returned live engine results. The generated arm64 one-dir bundle is approximately 118 MB before compression.
