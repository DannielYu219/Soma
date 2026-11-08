#!/usr/bin/env python3
"""Standalone frozen SearXNG entry point used by packaged Soma builds."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import secrets
import sys
import threading

from proxy import ProxyConfigError, clear_proxy_environment, configure_settings, discover_proxy


def watch_parent() -> None:
    # Avoid holding Python's buffered stdin lock during interpreter shutdown.
    try:
        while os.read(0, 4096):
            pass
    except OSError:
        pass
    os._exit(0)


def main() -> None:
    # Upstream version detection reads PATH even when launched without an environment.
    os.environ.setdefault("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
    if os.environ.get("SOMA_EXIT_ON_STDIN_CLOSE") == "1":
        threading.Thread(target=watch_parent, daemon=True, name="parent-watchdog").start()

    bundle_root = getattr(sys, "_MEIPASS", os.path.join(os.path.dirname(sys.executable), "_internal"))
    app_root = os.path.dirname(bundle_root)
    searx_dir = os.path.join(bundle_root, "searx")
    os.environ.setdefault("SEARXNG_DISABLE_ETC_SETTINGS", "1")
    os.environ.setdefault("SEARXNG_SETTINGS_PATH", os.path.join(bundle_root, "settings.yml"))
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

    import searx

    # PyInstaller collects SearXNG data files under the package; normalize its
    # resource root so templates, static files, and defaults resolve from the bundle.
    searx.searx_dir = searx_dir
    searx.searx_parent_dir = os.path.dirname(searx_dir)
    from searx import settings_loader

    settings_loader.searx_dir = searx_dir
    settings_loader.DEFAULT_SETTINGS_FILE = Path(searx_dir) / "settings.yml"
    configure_settings(searx.settings, selection)
    sys.argv = ["searx.webapp"]
    runpy.run_module("searx.webapp", run_name="__main__")


if __name__ == "__main__":
    main()
