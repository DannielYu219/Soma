"""Run: .searxng/venv/bin/python -m unittest discover -s tests -p 'proxy_test.py' -v

All traffic remains on loopback. Real installed SearXNG/curl_cffi is used by
integration tests, without a browser, desktop window, or external service.
"""
from __future__ import annotations

from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = ROOT / "server/searxng"
sys.path.insert(0, str(MODULE_DIR))
import proxy
import launcher


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


@contextmanager
def fake_proxy(protocol="http", *, status=200):
    captured = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            try:
                if protocol == "socks5h":
                    hello = proxy._read_exact(self.request, 3)
                    if hello != b"\x05\x01\x00":
                        return
                    self.request.sendall(b"\x05\x00")
                    head = proxy._read_exact(self.request, 4)
                    if not head:
                        return  # discovery only negotiates
                    atyp = head[3]
                    if atyp == 3:
                        length = proxy._read_exact(self.request, 1)[0]
                        host = proxy._read_exact(self.request, length).decode()
                    elif atyp == 1:
                        host = socket.inet_ntoa(proxy._read_exact(self.request, 4))
                    else:
                        return
                    port = struct.unpack("!H", proxy._read_exact(self.request, 2))[0]
                    captured.append(("SOCKS", host, port))
                    self.request.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
                    if port == 443:
                        return  # HTTPS routing evidence, deliberately no TLS server
                data = b""
                while b"\r\n\r\n" not in data and len(data) < 8192:
                    part = self.request.recv(4096)
                    if not part:
                        return
                    data += part
                first_line = data.split(b"\r\n", 1)[0].decode("ascii", "replace")
                captured.append(first_line)
                if first_line.startswith("CONNECT "):
                    self.request.sendall(f"HTTP/1.1 {status} Test\r\n\r\n".encode())
                    return
                body = b'{"via":"local-fake-proxy"}'
                self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            except (OSError, IndexError):
                pass  # malformed/wrong protocol probes are expected

    server = ProxyServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def clean_env():
    env = dict(os.environ)
    for name in tuple(env):
        if name.lower() in proxy.PROXY_ENV or name.startswith("SOMA_SEARXNG_") or name.startswith("SEARXNG_"):
            env.pop(name, None)
    env["PYTHONPATH"] = str(ROOT / ".searxng/src")
    env["SEARXNG_SETTINGS_PATH"] = str(MODULE_DIR / "settings.yml")
    env["SEARXNG_SECRET"] = "soma-local-proxy-test-secret"
    return env


class DiscoveryTests(unittest.TestCase):
    def select(self, env=None, output="", local=None):
        return proxy.discover_proxy(env or {}, "darwin", lambda: output, lambda: local or {})

    def test_explicit_wins_over_env_system_and_discovery(self):
        result = self.select({"SOMA_SEARXNG_PROXY": "socks5://user:secret@localhost:1082", "HTTPS_PROXY": "http://env:123"}, "HTTPEnable : 1\nHTTPProxy : system\nHTTPPort : 7890", {"https://": "http://local:7890"})
        self.assertEqual(result.source, "explicit proxy")
        self.assertEqual(result.proxies["https://"], "socks5h://user:secret@localhost:1082")
        self.assertNotIn("secret", repr(result))
        self.assertNotIn("secret", result.summary())

    def test_direct_override_prevents_all_detection(self):
        for value in ("direct", "off", "none"):
            with self.subTest(value=value):
                result = proxy.discover_proxy({"SOMA_SEARXNG_PROXY": value, "ALL_PROXY": "http://env:10"}, "darwin", lambda: self.fail("system called"), lambda: self.fail("discovery called"))
                self.assertEqual(result.proxies, {})

    def test_environment_protocols_and_lowercase_priority(self):
        result = self.select({"http_proxy": "http://lower:7890", "HTTP_PROXY": "http://upper:7890", "HTTPS_PROXY": "socks5://secure:1082", "ALL_PROXY": "http://all:1080"})
        self.assertEqual(result.proxies, {"http://": "http://lower:7890", "https://": "socks5h://secure:1082"})
        self.assertEqual(result.source, "environment proxy")

    def test_environment_all_proxy_and_single_protocol_fallback(self):
        for env in ({"ALL_PROXY": "localhost:7890"}, {"HTTP_PROXY": "localhost:7890"}, {"HTTPS_PROXY": "localhost:7890"}):
            with self.subTest(env=env):
                self.assertEqual(self.select(env).proxies, {"http://": "http://localhost:7890", "https://": "http://localhost:7890"})

    def test_macos_https_is_http_connect_and_socks_fills_missing(self):
        output = "<dictionary> {\nHTTPEnable : 0\nHTTPProxy : disabled\nHTTPPort : 1\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\nSOCKSEnable : 1\nSOCKSProxy : ::1\nSOCKSPort : 1082\n}"
        result = self.select(output=output)
        self.assertEqual(result.proxies, {"http://": "socks5h://[::1]:1082", "https://": "http://127.0.0.1:7890"})
        self.assertEqual(result.source, "macOS manual proxy")

    def test_macos_pac_is_transparent_and_falls_back(self):
        local = {"https://": "http://127.0.0.1:7890"}
        result = self.select(output="ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : https://user:password@pac.test/file", local=local)
        self.assertEqual(result.proxies, local)
        self.assertIn("PAC/WPAD", result.warnings[0])
        self.assertNotIn("password", str(result.warnings))

    def test_macos_scutil_failure_falls_back(self):
        def unavailable():
            raise subprocess.TimeoutExpired("scutil", 2)
        result = proxy.discover_proxy({}, "darwin", unavailable, lambda: {})
        self.assertEqual(result.proxies, {})
        self.assertTrue(result.warnings)

    def test_disabled_or_invalid_macos_manual_proxy_is_not_used(self):
        result = self.select(output="HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 99999")
        self.assertEqual(result.proxies, {})
        self.assertTrue(result.warnings)

    def test_invalid_proxy_errors_never_echo_credentials(self):
        for value in ("ftp://user:secret@host", "http://user:secret@host:nope", "http://user:secret@host:99999", "http://user:secret@host/path", "http://"):
            with self.subTest(value=value):
                with self.assertRaises(proxy.ProxyConfigError) as error:
                    proxy.normalize_proxy(value)
                self.assertNotIn("secret", str(error.exception))

    def test_ipv6_https_and_socks4_are_preserved(self):
        for value in ("https://[::1]:7890", "socks4a://127.0.0.1:1082", "socks4://localhost:1082"):
            self.assertEqual(proxy.normalize_proxy(value), value)

    def test_loopback_http_connect_validation(self):
        with fake_proxy() as (port, requests):
            self.assertTrue(proxy.validate_local_proxy("127.0.0.1", port, "http"))
            self.assertFalse(proxy.validate_local_proxy("127.0.0.1", port, "socks5h"))
            self.assertEqual(proxy.discover_local_proxy((port,)), {"http://": f"http://127.0.0.1:{port}", "https://": f"http://127.0.0.1:{port}"})
            self.assertIn("CONNECT example.com:443 HTTP/1.1", requests)

    def test_loopback_socks5_validation_and_remote_dns(self):
        with fake_proxy("socks5h") as (port, _):
            self.assertTrue(proxy.validate_local_proxy("127.0.0.1", port, "socks5h"))
            self.assertFalse(proxy.validate_local_proxy("127.0.0.1", port, "http"))
            self.assertEqual(proxy.discover_local_proxy((port,))["https://"], f"socks5h://127.0.0.1:{port}")

    def test_http_error_or_auth_required_is_not_auto_selected(self):
        for status in (400, 407, 502):
            with fake_proxy(status=status) as (port, _):
                self.assertFalse(proxy.validate_local_proxy("127.0.0.1", port, "http"))

    def test_plain_tcp_listener_is_not_proxy(self):
        class NotProxy(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.sendall(b"unrelated service\r\n")
        with ProxyServer(("127.0.0.1", 0), NotProxy) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(proxy.discover_local_proxy((server.server_address[1],)), {})
            finally:
                server.shutdown()
                thread.join(timeout=3)

    def test_default_port_order_covers_7890_and_1082(self):
        self.assertEqual(proxy.LOCAL_PORTS[:2], (7890, 1082))
        calls = []
        def validate(host, port, protocol):
            calls.append((host, port, protocol))
            return host == "127.0.0.1" and protocol == "socks5h"
        with patch.object(proxy, "validate_local_proxy", side_effect=validate):
            result = proxy.discover_local_proxy((7890, 1082))
        self.assertEqual(result["https://"], "socks5h://127.0.0.1:7890")
        self.assertIn(("127.0.0.1", 1082, "socks5h"), calls)

    def test_child_environment_is_cleared_and_settings_are_explicit(self):
        with patch.dict(os.environ, {"HTTP_PROXY": "http://secret@host", "https_proxy": "http://host", "NO_PROXY": "*", "SOMA_SEARXNG_PROXY": "direct"}, clear=True):
            proxy.clear_proxy_environment()
            self.assertEqual(dict(os.environ), {"SOMA_SEARXNG_PROXY": "direct"})
        settings = {"outgoing": {"proxies": {"all://": "old"}, "extra_proxy_timeout": 1}}
        selection = proxy.ProxySelection({"https://": "http://host:7890"}, "test")
        proxy.configure_settings(settings, selection)
        self.assertEqual(settings["outgoing"]["proxies"], selection.proxies)
        self.assertEqual(settings["outgoing"]["extra_proxy_timeout"], 5)
        proxy.configure_settings(settings, proxy.ProxySelection())
        self.assertEqual(settings["outgoing"]["proxies"], {})


@unittest.skipUnless((ROOT / ".searxng/src/searx").is_dir() and importlib.util.find_spec("curl_cffi"), "requires installed SearXNG venv")
class IntegrationTests(unittest.TestCase):
    def test_launcher_passes_http_and_socks_to_real_searxng_network(self):
        # Execute the real launcher's main up to run_module, then drive the real
        # outgoing network. .invalid avoids any chance of direct external DNS.
        script = '''
import json, os, sys
sys.path.insert(0, sys.argv[1])
import launcher
from unittest.mock import patch
def exercise(*args, **kwargs):
    import searx
    from searx import network
    network.initialize(settings_engines=[{"name": "test"}], settings_outgoing=searx.settings["outgoing"])
    network.get_network().enable_http = True
    result = network.get("http://soma-proxy-test.invalid/probe", timeout=3)
    assert result.json() == {"via": "local-fake-proxy"}, result.text
    enabled = [e["name"] for e in searx.settings["engines"] if not e.get("disabled", False)]
    assert {"google", "duckduckgo", "brave", "bing", "sogou", "360search"} <= set(enabled), enabled
    assert searx.settings["outgoing"]["proxies"], "missing real outgoing.proxies"
    from curl_cffi.requests.exceptions import RequestException
    try:
        network.get("https://soma-proxy-test.invalid/secure", timeout=3)
    except RequestException:
        pass  # the fake proxy closes after CONNECT/SOCKS, before TLS
    else:
        raise AssertionError("fake proxy unexpectedly provided TLS")
    print("PROXY_INTEGRATION_OK")
    from searx.network.network import done
    done()
with patch.object(launcher.runpy, "run_module", side_effect=exercise):
    launcher.main()
'''
        for protocol in ("http", "socks5h"):
            with self.subTest(protocol=protocol), fake_proxy(protocol) as (port, captured):
                env = clean_env()
                env["SOMA_SEARXNG_PROXY"] = f"{protocol}://127.0.0.1:{port}"
                # Deliberately hostile inherited values must not bypass routing.
                env["ALL_PROXY"] = "http://127.0.0.1:1"
                env["NO_PROXY"] = "*"
                result = subprocess.run([sys.executable, "-c", script, str(MODULE_DIR)], env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("PROXY_INTEGRATION_OK", result.stdout)
                if protocol == "http":
                    self.assertIn("GET http://soma-proxy-test.invalid/probe HTTP/1.1", captured)
                    self.assertIn("CONNECT soma-proxy-test.invalid:443 HTTP/1.1", captured)
                else:
                    self.assertIn(("SOCKS", "soma-proxy-test.invalid", 80), captured)
                    self.assertIn(("SOCKS", "soma-proxy-test.invalid", 443), captured)
                    self.assertIn("GET /probe HTTP/1.1", captured)

    def test_real_launcher_stdin_eof_shutdown(self):
        env = clean_env()
        env["SOMA_EXIT_ON_STDIN_CLOSE"] = "1"
        env["SOMA_SEARXNG_PROXY"] = "direct"
        # A private stub confirms the production launcher watches stdin even
        # while the webapp blocks. It cannot launch real engine init traffic.
        with tempfile.TemporaryDirectory(prefix="soma-proxy-watchdog-") as directory:
            source = Path(directory)
            package = source / "searx"
            package.mkdir()
            (package / "__init__.py").write_text("settings = {'outgoing': {'proxies': {}}}\n")
            (package / "webapp.py").write_text("import threading\nprint('WATCHDOG_READY', flush=True)\nthreading.Event().wait()\n")
            env["SOMA_SEARXNG_DIR"] = str(source)
            child = subprocess.Popen([sys.executable, str(MODULE_DIR / "launcher.py")], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                # communicate closes stdin, so wait for readiness separately.
                import selectors
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(timeout=5), "launcher did not start")
                self.assertEqual(child.stdout.readline().strip(), "WATCHDOG_READY")
                child.stdin.close()
                child.wait(timeout=5)
                self.assertEqual(child.returncode, 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                for stream in (child.stdout, child.stderr):
                    stream.close()

    def test_invalid_override_exit_does_not_leak_credentials(self):
        env = clean_env()
        env["SOMA_SEARXNG_PROXY"] = "ftp://user:never-log-this@localhost:7890"
        result = subprocess.run([sys.executable, str(MODULE_DIR / "launcher.py")], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("never-log-this", result.stdout + result.stderr)
        self.assertIn("Invalid proxy configuration", result.stderr)


if __name__ == "__main__":
    unittest.main()
