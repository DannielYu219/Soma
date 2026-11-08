# SearXNG proxy discovery

Both Node autostart (`SOMA_SEARXNG_AUTOSTART=1`) and the Rust desktop launcher execute the same Python entry point, `server/searxng/launcher.py`, using `.searxng/venv/bin/python` and `.searxng/src`. This changes only the SearXNG child process. No macOS network settings are written. External instances selected with `SOMA_SEARXNG_URL` keep their own proxy configuration.

Selection order:

1. `SOMA_SEARXNG_PROXY`: a proxy URL, or `direct`/`off`/`none` to disable proxies. Missing, empty, or `auto` enables discovery. Explicit configuration wins even when the proxy is unavailable; Soma does not silently route around it.
2. Environment `http_proxy`, `https_proxy`, `all_proxy` (lowercase takes precedence over uppercase). Protocol-specific values win over `ALL_PROXY`. A single protocol value is also used for the other protocol, since HTTP CONNECT and SOCKS proxies commonly support both.
3. On macOS, `/usr/sbin/scutil --proxy`: enabled manual HTTP and HTTPS proxies, with SOCKS filling missing protocols. `HTTPSProxy` is interpreted as an HTTP CONNECT proxy, as macOS specifies, rather than a TLS connection to the proxy.
4. Local loopback ports, in order: **7890, 1082**, 7897, 1080, 7891, 1081, 8080, 8889. IPv4 and IPv6 loopback are checked. HTTP and SOCKS5 are probed concurrently, then the first successful candidate in this deterministic port/address/protocol order is used.
5. Direct connections if nothing is configured or discovered. The startup log reports this explicitly.

Examples:

```sh
# Default system/environment detection plus loopback fallback
SOMA_SEARXNG_AUTOSTART=1 npm start

# Force a mixed HTTP/CONNECT proxy
SOMA_SEARXNG_PROXY=http://127.0.0.1:7890 SOMA_SEARXNG_AUTOSTART=1 npm start

# Force SOCKS5 with proxy-side DNS
SOMA_SEARXNG_PROXY=socks5h://127.0.0.1:1082 SOMA_SEARXNG_AUTOSTART=1 npm start

# Explicitly use direct connections
SOMA_SEARXNG_PROXY=direct SOMA_SEARXNG_AUTOSTART=1 npm start
```

URLs support `http`, `https` (TLS to the proxy), `socks4`, `socks4a`, `socks5`, and `socks5h`. Bare host:port values imply HTTP. `socks` and `socks5` normalize to `socks5h`, resolving destination names through the proxy. URL-encoded username/password authentication can be supplied explicitly or through environment variables. Credentials are never included in Soma's selection messages or configuration errors. macOS Keychain credentials are not extracted; authenticated system proxies may need an explicit URL. Automatically discovered proxies must support anonymous access.

A TCP listener alone is insufficient for autodetection. HTTP candidates must return a complete HTTP/1.x 200 CONNECT response for `example.com:443`; Soma immediately closes the tunnel without sending TLS/application data. SOCKS candidates must complete the SOCKS5 no-auth method negotiation. This is a protocol check, not a claim that every search engine is reachable. HTTP checks can touch the proxy's external route to example.com; SOCKS discovery sends only the local handshake. Detection has bounded socket timeouts (0.6 seconds per attempt) and runs concurrently. A generic web server, HTTP error, proxy-auth challenge, or closed port is rejected.

The launcher imports `searx` to load its settings, injects the selected mapping into the actual `searx.settings['outgoing']['proxies']`, and only then executes `searx.webapp`. The installed SearXNG networking layer takes this mapping into its curl_cffi client options. Merely setting `HTTP_PROXY` is not relied on. Inherited HTTP(S)/ALL/NO_PROXY variables are cleared in the child after discovery so curl cannot bypass explicit selection or a `direct` override. Consequently `NO_PROXY`, macOS exception lists, and bypass rules are not applied to outgoing SearXNG requests; the selected proxy covers all search traffic. The local Node-to-SearXNG API connection is unaffected. Proxy selection is fixed for the child's lifetime; restart Soma after changing network configuration.

PAC/WPAD JavaScript is **not evaluated**. If macOS enables it, a credential-free warning explains that only manual settings and loopback detection are supported. An applicable manual proxy can still be used; otherwise loopback fallback is attempted. Invalid explicit or environment proxy URLs fail startup with a generic error instead of silently changing the route. An unreachable explicitly configured or system proxy is retained rather than replaced by a lower-priority route.

Google, DuckDuckGo, Brave, Bing, Sogou, and 360 Search are enabled as the default general search set, with 10-second engine timeouts. A selected proxy adds 5 seconds of proxy allowance. The first three are restored even without a proxy: there is no mainland-only default policy. Captchas, upstream blocks, unavailable proxy subscriptions, rate limits, and individual engine changes can still prevent results.

Both parent paths retain piped stdin. The Python watchdog exits on EOF, including abrupt parent termination. Normal parent shutdown can also terminate the child directly. No generated settings file containing proxy credentials is written. The desktop now shares one log descriptor for SearXNG stdout/stderr so reopening/truncating the same file cannot overwrite its proxy startup message.

Validation (no browser or desktop window):

```sh
.searxng/venv/bin/python -m unittest discover -s tests -p 'proxy_test.py' -v
node --experimental-strip-types --test tests/proxy.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
```

The Python suite checks precedence, macOS parsing/PAC diagnostics, malformed URL redaction, port order, false-positive rejection, HTTP/SOCKS detection, real SearXNG/curl_cffi routing through local fake proxies with an unresolvable `.invalid` destination, default engines, and watchdog shutdown. The Node test checks its actual startup path uses the shared launcher and stdin lifetime behavior. All fake proxies and children are stopped by the tests. The real SearXNG routing test does not contact external search engines.
