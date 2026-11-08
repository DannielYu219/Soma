// The desktop app owns its bundled services. No project checkout or installed runtimes are needed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
fn sync_window_mode(window: &tauri::WebviewWindow) {
    let mode = if window.is_fullscreen().unwrap_or(false) { "fullscreen" }
        else if window.is_maximized().unwrap_or(false) { "maximized" }
        else { "windowed" };
    let _ = window.eval(&format!("document.documentElement.dataset.windowMode='{mode}'"));
}

const READY_TIMEOUT: Duration = Duration::from_secs(45);

struct Services(Mutex<Vec<Child>>);
impl Drop for Services {
    fn drop(&mut self) {
        if let Ok(children) = self.0.get_mut() {
            for child in children.iter_mut().rev() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn random_secret() -> Result<String, Box<dyn Error>> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn available_port() -> Result<u16, Box<dyn Error>> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn log_streams(command: &mut Command, data: &Path, name: &str) -> Result<(), Box<dyn Error>> {
    let directory = data.join("logs");
    fs::create_dir_all(&directory)?;
    let log = File::create(directory.join(name))?;
    command.stdout(Stdio::from(log.try_clone()?)).stderr(Stdio::from(log));
    Ok(())
}

fn search_command(resources: &Path) -> Command {
    let mut command = Command::new(resources.join("search/soma-search/soma-search"));
    command.env("SEARXNG_SETTINGS_PATH", resources.join("settings.yml"));
    command
}

fn start_services(resources: &Path, data: &Path, backend_port: u16, search_port: u16, token: &str) -> Result<Services, Box<dyn Error>> {
    let services = Services(Mutex::new(Vec::new()));
    fs::create_dir_all(data.join("cache"))?;
    let mut search = search_command(resources);
    search.current_dir(data)
        .env("SEARXNG_SECRET", random_secret()?)
        .env("SEARXNG_PORT", search_port.to_string())
        .env("SEARXNG_BIND_ADDRESS", "127.0.0.1")
        .env("SEARXNG_CACHE_PATH", data.join("cache"))
        .env("XDG_CACHE_HOME", data.join("cache"))
        .env("SOMA_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped());
    log_streams(&mut search, data, "search.log")?;
    services.0.lock().unwrap().push(search.spawn()?);

    let mut backend = Command::new(resources.join("backend/node"));
    backend.arg(resources.join("backend/server.mjs"))
        .current_dir(data)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("SOMA_BACKEND_HOST", "127.0.0.1")
        .env("SOMA_BACKEND_PORT", backend_port.to_string())
        .env("SOMA_STATIC_DIR", resources.join("ui"))
        .env("SOMA_DATA_DIR", data.join("settings"))
        .env("SOMA_SEARXNG_URL", format!("http://127.0.0.1:{search_port}"))
        .env("SOMA_SEARXNG_AUTOSTART", "0")
        .env("SOMA_SESSION_TOKEN", token)
        .env("SOMA_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped());
    log_streams(&mut backend, data, "backend.log")?;
    services.0.lock().unwrap().push(backend.spawn()?);
    Ok(services)
}

fn wait_for_health(port: u16, services: &Services) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        for child in services.0.lock().unwrap().iter_mut() {
            if let Some(status) = child.try_wait()? {
                return Err(format!("A bundled service stopped during startup ({status}). See Soma logs in Application Support.").into());
            }
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.starts_with("HTTP/1.1 200") && response.contains("soma-backend") { return Ok(()); }
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("Soma services did not start in time; see logs in Application Support/Soma.".into())
}

fn self_test() -> Result<(), Box<dyn Error>> {
    let executable = std::env::current_exe()?;
    let resources = executable.parent().and_then(Path::parent).ok_or("Invalid app layout")?.join("Resources/runtime");
    let data = std::env::temp_dir().join(format!("soma-bundle-check-{}", std::process::id()));
    fs::create_dir_all(&data)?;
    let backend_port = available_port()?;
    let mut search_port = available_port()?;
    while backend_port == search_port { search_port = available_port()?; }
    let services = start_services(&resources, &data, backend_port, search_port, &random_secret()?)?;
    wait_for_health(backend_port, &services)?;
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut ready = false;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], search_port)), Duration::from_millis(250)) {
            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
            stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") { ready = true; break; }
        }
        thread::sleep(Duration::from_millis(200));
    }
    if !ready { return Err(format!("Bundled search startup failed; logs: {}", data.display()).into()); }
    if !resources.join("ui/index.html").is_file() { return Err("Bundled UI missing".into()); }
    drop(services);
    println!("SOMA_BUNDLE_SELF_TEST_OK: backend, search, UI resources, owned-process shutdown; logs: {}", data.display());
    Ok(())
}

fn main() {
    if std::env::args().any(|argument| argument == "--self-test") {
        if let Err(error) = self_test() { eprintln!("SOMA_BUNDLE_SELF_TEST_FAILED: {error}"); std::process::exit(1); }
        return;
    }
    let app = tauri::Builder::default()
        .setup(|app| {
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build-resources")
            } else { app.path().resource_dir()?.join("runtime") };
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            // Prefer a stable origin, but other local servers must not prevent startup.
            // Conversation state is hydrated from the app's disk store on every origin.
            let reservation = TcpListener::bind(("127.0.0.1", 8787))
                .or_else(|_| TcpListener::bind("127.0.0.1:0"))?;
            let backend_port = reservation.local_addr()?.port();
            let search_port = available_port()?;
            drop(reservation);
            let token = random_secret()?;
            let services = start_services(&resources, &data, backend_port, search_port, &token)?;
            wait_for_health(backend_port, &services)?;
            app.manage(services);
            let url = tauri::Url::parse(&format!("http://127.0.0.1:{backend_port}/?session={token}"))?;
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Soma").inner_size(1280.0, 800.0).min_inner_size(800.0, 560.0);
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true)
                .initialization_script("document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.windowMode='windowed'},{once:true});")
                .on_page_load(|window, _| sync_window_mode(&window));
            let window = builder.build()?;
            #[cfg(target_os = "macos")]
            {
                let tracked_window = window.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true)) {
                        sync_window_mode(&tracked_window);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize Soma desktop app");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(services) = handle.try_state::<Services>() {
                if let Ok(mut children) = services.0.lock() {
                    for child in children.iter_mut().rev() { let _ = child.kill(); let _ = child.wait(); }
                    children.clear();
                }
            }
        }
    });
}
