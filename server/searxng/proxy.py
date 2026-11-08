"""Process-local proxy discovery for Soma's SearXNG launcher (stdlib only)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import os
import re
import socket
import subprocess
import sys
import time
from typing import Callable, Mapping
from urllib.parse import urlsplit

# Mixed HTTP/SOCKS ports used by Clash, Mihomo, Surge, and common SOCKS clients.
LOCAL_PORTS = (7890, 1082, 7897, 1080, 7891, 1081, 8080, 8889)
PROXY_ENV = ("http_proxy", "https_proxy", "all_proxy", "no_proxy")


class ProxyConfigError(ValueError):
    """A safe-to-log error: never include the supplied proxy URL."""


@dataclass
class ProxySelection:
    proxies: dict[str, str] = field(default_factory=dict, repr=False)
    source: str = "direct"
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        protocols = sorted({urlsplit(url).scheme for url in self.proxies.values()})
        return f"{self.source} ({', '.join(protocols)})" if protocols else self.source


def normalize_proxy(value: str) -> str:
    value = value.strip()
    if "://" not in value:
        value = "http://" + value
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https", "socks4", "socks4a", "socks5", "socks5h", "socks"}:
            raise ValueError()
        if not parsed.hostname or parsed.port == 0 or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError()
        # Remote DNS is essential when the direct resolver cannot reach blocked engines.
        scheme = {"socks": "socks5h", "socks5": "socks5h"}.get(scheme, scheme)
        return f"{scheme}://{parsed.netloc}"
    except (ValueError, TypeError):
        raise ProxyConfigError("Invalid proxy configuration; use an HTTP(S) or SOCKS proxy URL.") from None


def _both(value: str) -> dict[str, str]:
    proxy = normalize_proxy(value)
    return {"http://": proxy, "https://": proxy}


def environment_proxies(env: Mapping[str, str]) -> dict[str, str]:
    def get(name: str) -> str:
        # Match the conventional lowercase-before-uppercase preference.
        return env.get(name.lower(), "").strip() or env.get(name.upper(), "").strip()

    all_proxy, http, https = get("all_proxy"), get("http_proxy"), get("https_proxy")
    if not (all_proxy or http or https):
        return {}
    # A lone HTTP_PROXY commonly denotes a mixed/CONNECT proxy for both protocols.
    return {
        "http://": normalize_proxy(http or all_proxy or https),
        "https://": normalize_proxy(https or all_proxy or http),
    }


def macos_proxies(output: str) -> tuple[dict[str, str], list[str]]:
    fields = dict(re.findall(r"^\s*(\w+)\s*:\s*(.*?)\s*$", output, re.MULTILINE))
    warnings = []
    if fields.get("ProxyAutoConfigEnable") == "1" or fields.get("ProxyAutoDiscoveryEnable") == "1":
        warnings.append("macOS PAC/WPAD is enabled but is not evaluated; only manual proxies and loopback discovery are supported.")

    def endpoint(prefix: str, scheme: str) -> str:
        if fields.get(prefix + "Enable") != "1":
            return ""
        host, port = fields.get(prefix + "Proxy", ""), fields.get(prefix + "Port", "")
        if not host or not port.isdigit() or not 0 < int(port) < 65536:
            warnings.append("An enabled macOS manual proxy has no usable host/port; skipping it.")
            return ""
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return normalize_proxy(f"{scheme}://{host}:{port}")

    http, https, socks = endpoint("HTTP", "http"), endpoint("HTTPS", "http"), endpoint("SOCKS", "socks5h")
    # macOS HTTPSProxy means HTTP CONNECT for HTTPS destinations, not TLS to the proxy.
    if not (http or https or socks):
        return {}, warnings
    return {"http://": http or socks or https, "https://": https or socks or http}, warnings


def read_macos_proxy() -> str:
    result = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True, text=True, timeout=2, check=True)
    return result.stdout


def _read_exact(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            break
        data += chunk
    return data


def validate_local_proxy(host: str, port: int, protocol: str, timeout: float = 0.6) -> bool:
    """Reject mere TCP listeners. HTTP must tunnel; SOCKS must accept no-auth v5.

    HTTP probes establish then immediately close a CONNECT tunnel to example.com:443
    without sending TLS or an HTTP request. SOCKS probes only negotiate locally.
    This detects the protocol, not reachability of every search engine.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            if protocol == "socks5h":
                sock.sendall(b"\x05\x01\x00")
                return _read_exact(sock, 2) == b"\x05\x00"
            sock.sendall(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            data = b""
            deadline = time.monotonic() + timeout
            while b"\r\n\r\n" not in data and len(data) < 8192:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                sock.settimeout(remaining)
                chunk = sock.recv(1024)
                if not chunk:
                    break
                data += chunk
            return bool(re.match(rb"HTTP/1\.[01] 200(?:\s|\r)", data)) and b"\r\n\r\n" in data
    except (OSError, ValueError):
        return False


def discover_local_proxy(ports: tuple[int, ...] = LOCAL_PORTS) -> dict[str, str]:
    # Probe concurrently to keep unavailable ports from serially delaying startup.
    candidates = [(host, port, protocol) for port in ports for host in ("127.0.0.1", "::1") for protocol in ("http", "socks5h")]
    with ThreadPoolExecutor(max_workers=16) as executor:
        valid = list(executor.map(lambda args: validate_local_proxy(*args), candidates))
    for (host, port, protocol), accepted in zip(candidates, valid):
        if accepted:
            host = f"[{host}]" if ":" in host else host
            return _both(f"{protocol}://{host}:{port}")
    return {}


def discover_proxy(
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    system_reader: Callable[[], str] = read_macos_proxy,
    local_discoverer: Callable[[], dict[str, str]] = discover_local_proxy,
) -> ProxySelection:
    env = os.environ if env is None else env
    mode = env.get("SOMA_SEARXNG_PROXY", "auto").strip()
    if mode.lower() in {"direct", "off", "none"}:
        return ProxySelection(source="explicit direct")
    if mode and mode.lower() != "auto":
        return ProxySelection(_both(mode), "explicit proxy")
    proxies = environment_proxies(env)
    if proxies:
        return ProxySelection(proxies, "environment proxy")
    warnings = []
    if (platform or sys.platform) == "darwin":
        try:
            proxies, warnings = macos_proxies(system_reader())
            if proxies:
                return ProxySelection(proxies, "macOS manual proxy", warnings)
        except (OSError, subprocess.SubprocessError):
            warnings.append("Could not read macOS proxy settings; trying loopback discovery.")
    proxies = local_discoverer()
    return ProxySelection(proxies, "validated loopback proxy" if proxies else "direct (no proxy discovered)", warnings)


def clear_proxy_environment() -> None:
    # curl may still honor inherited proxy/no_proxy variables underneath explicit
    # settings. Make this child deterministic; never mutate the parent's or OS config.
    for name in tuple(os.environ):
        if name.lower() in PROXY_ENV:
            os.environ.pop(name, None)


def configure_settings(settings: dict, selection: ProxySelection) -> None:
    settings["outgoing"]["proxies"] = dict(selection.proxies)
    if selection.proxies:
        settings["outgoing"]["extra_proxy_timeout"] = max(5, settings["outgoing"].get("extra_proxy_timeout", 0))
