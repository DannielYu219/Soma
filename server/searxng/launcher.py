#!/usr/bin/env python3
"""Shared Node/desktop entry point; run with the installed SearXNG venv."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import secrets
import sys
import threading

from proxy import ProxyConfigError, clear_proxy_environment, configure_settings, discover_proxy


def watch_parent() -> None:
    # Both owners retain a piped stdin. EOF also handles abrupt parent termination.
    sys.stdin.read()
    os._exit(0)


def main() -> None:
    if os.environ.get("SOMA_EXIT_ON_STDIN_CLOSE") == "1":
        threading.Thread(target=watch_parent, daemon=True).start()
    root = Path(__file__).resolve().parents[2]
    source = Path(os.environ.get("SOMA_SEARXNG_DIR", root / ".searxng/src")).resolve()
    sys.path.insert(0, str(source))
    os.environ.setdefault("SEARXNG_SETTINGS_PATH", str(Path(__file__).with_name("settings.yml")))
    os.environ.setdefault("SEARXNG_SECRET", secrets.token_hex(32))
    os.environ.setdefault("SEARXNG_BIND_ADDRESS", "127.0.0.1")
    os.environ.setdefault("SEARXNG_PORT", os.environ.get("SOMA_SEARXNG_PORT", "8888"))
    try:
        selection = discover_proxy()
    except ProxyConfigError as error:
        print(f"[soma-proxy] {error}", file=sys.stderr, flush=True)
        raise SystemExit(2) from None
    clear_proxy_environment()
    print(f"[soma-proxy] {selection.summary()}", file=sys.stderr, flush=True)
    for warning in selection.warnings:
        print(f"[soma-proxy] {warning}", file=sys.stderr, flush=True)
    # searx.__init__ loads settings, but webapp imports initialize networking later.
    # Mutate the real dictionary so curl_cffi clients receive actual proxy options.
    import searx

    configure_settings(searx.settings, selection)
    sys.argv = ["searx.webapp"]
    runpy.run_module("searx.webapp", run_name="__main__")


if __name__ == "__main__":
    main()
