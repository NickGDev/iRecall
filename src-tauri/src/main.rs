// iRecall tray — menu-bar status + control, supervisor for the local server.
// Tauri/Rust port of the former Swift tray (scripts/iRecallTray.swift): same
// menu, same 5s health poll, same supervision (fixed 3s respawn gap,
// SIGTERM on quit so node exits cleanly and SQLite WAL checkpoints).
//
// The node runtime + server tree ship as Tauri resources under binaries/
// (staged by scripts/stage-runtime.sh); data lives in the per-OS app-data
// dir — macOS uses ~/Library/Application Support/iRecall (renamed from the
// pre-rename .../Recall dir; old installs' data stays in the old path).
use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};

const BASE: &str = "http://127.0.0.1:8787";
const RESPAWN_DELAY: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_secs(5);

// Extension presence, straight from the server's /config response. warn =
// not connected && not dismissed — drives the tray badge, menu item and the
// floating setup window.
#[derive(Clone, Copy, PartialEq)]
struct ExtState {
    connected: bool,
    never: bool,
    dismissed: bool,
    last_seen: i64,
}

fn ext_of(config: &serde_json::Value) -> Option<ExtState> {
    let e = config.get("extension")?;
    Some(ExtState {
        connected: e.get("connected")?.as_bool()?,
        never: e.get("never")?.as_bool()?,
        dismissed: e.get("dismissed")?.as_bool()?,
        last_seen: e.get("lastSeen").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

fn is_warn(ext: Option<ExtState>) -> bool {
    ext.is_some_and(|e| !e.connected && !e.dismissed)
}

struct UiState {
    healthy: bool,
    recording: bool,
    token: Option<String>,
    ext: Option<ExtState>,
    setup_prompted: bool,
}

struct Icons {
    base: tauri::image::Image<'static>,
    warn: tauri::image::Image<'static>,
}

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    setup: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
    icons: Arc<Icons>,
}

struct SupervisorPid(Mutex<Option<u32>>);
struct QuitFlag(Arc<AtomicBool>);

fn http_get(path: &str, token: Option<&str>) -> Option<serde_json::Value> {
    let mut req = ureq::get(&format!("{BASE}{path}")).timeout(Duration::from_secs(2));
    if let Some(t) = token {
        req = req.set("authorization", &format!("Bearer {t}"));
    }
    let resp = req.call().ok()?;
    resp.into_json::<serde_json::Value>().ok()
}

fn health_ok() -> bool {
    http_get("/health", None).is_some()
}

fn post_config(recording: bool, token: &str) -> bool {
    ureq::post(&format!("{BASE}/config"))
        .timeout(Duration::from_secs(2))
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json")
        .send_json(json!({ "recording": recording }))
        .is_ok()
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // macOS: ~/Library/Application Support/iRecall. Elsewhere: Tauri default.
    if cfg!(target_os = "macos") {
        app.path()
            .config_dir()
            .map(|d| d.join("iRecall"))
            .map_err(|e| e.to_string())
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

// "The app auto prepares a dir with the extension": copy the bundled unpacked
// extension to a stable path under the data dir so Load-unpacked keeps working
// across app updates and never points Chrome into the .app bundle. Re-copied
// every launch (cheap, keeps the dir in sync with the shipped version).
fn prepare_extension_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dest = data_dir(app).ok()?.join("extension");
    let src = app
        .path()
        .resource_dir()
        .ok()?
        .join("binaries")
        .join("extension");
    if src.join("manifest.json").exists() {
        let _ = std::fs::remove_dir_all(&dest);
        copy_dir_all(&src, &dest).ok()?;
    }
    dest.exists().then_some(dest)
}

// Floating setup panel, always-on-top so it overlays Chrome while the user
// follows the steps in it.
fn open_setup_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let width = 460.0f64;
    let height = 560.0f64;
    let mut pos = (24.0f64, 40.0f64); // fallback: top-left
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let mx = monitor.position().x as f64 / scale;
        let my = monitor.position().y as f64 / scale;
        let mw = monitor.size().width as f64 / scale;
        pos = (mx + mw - width - 40.0, my + 48.0);
    }
    let _ = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
        .title("Set up iRecall for Chrome")
        .inner_size(width, height)
        .resizable(false)
        .always_on_top(true)
        .position(pos.0, pos.1)
        .build();
}

fn close_setup_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.close();
    }
}

fn spawn_server(app: &AppHandle) -> Result<Child, String> {
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let triple = env!("TARGET");
    let node = if cfg!(windows) {
        res.join("binaries").join(format!("node-{triple}.exe"))
    } else {
        res.join("binaries").join(format!("node-{triple}"))
    };
    let server_dir = res.join("binaries").join("server");
    let data = data_dir(app)?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        // Bundled resources can lose the exec bit (DMG/AppImage edge cases).
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755));
    }

    let log_path = data.join("server.log");
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600); // same privacy guarantee as the server's umask 077
    }
    let log = opts
        .open(&log_path)
        .map_err(|e| format!("open {}: {e}", log_path.display()))?;

    Command::new(node)
        .args(["--max-old-space-size=384", "dist/main.js"])
        .current_dir(&server_dir)
        .env("IRECALL_DB_PATH", data.join("irecall.db"))
        .env("IRECALL_TOKEN_PATH", data.join(".token"))
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("spawn: {e}"))
}

fn terminate(child: &mut Child) {
    // Swift tray used Process.interrupt() (SIGTERM) — node exits cleanly and
    // SQLite WAL checkpoints. Windows has no signals: taskkill /F /T.
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/F", "/T"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }
}

// KeepAlive parity: respawn ~3s after any exit until the tray quits. If the
// port is already served by another instance (dev run, old LaunchAgent),
// supervise the UI only — don't fight it, don't kill it on quit.
fn supervisor(app: AppHandle, quitting: Arc<AtomicBool>) {
    loop {
        if quitting.load(Ordering::Relaxed) {
            break;
        }
        if health_ok() {
            let pid = app.state::<SupervisorPid>();
            *pid.0.lock().unwrap() = None;
            thread::sleep(POLL_INTERVAL);
            continue;
        }
        match spawn_server(&app) {
            Ok(mut child) => {
                let pid = app.state::<SupervisorPid>();
                *pid.0.lock().unwrap() = Some(child.id());
                // Poll instead of blocking wait: quit stays responsive and the
                // SIGTERM path lives on this thread.
                loop {
                    if quitting.load(Ordering::Relaxed) {
                        terminate(&mut child);
                        break;
                    }
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => thread::sleep(Duration::from_millis(200)),
                    }
                }
            }
            Err(e) => eprintln!("iRecall: server spawn failed: {e}"),
        }
        if quitting.load(Ordering::Relaxed) {
            break;
        }
        thread::sleep(RESPAWN_DELAY);
    }
}

fn poller(app: AppHandle, quitting: Arc<AtomicBool>, ui: Arc<Mutex<UiState>>, items: TrayItems) {
    let mut was_warn = false;
    while !quitting.load(Ordering::Relaxed) {
        let healthy = health_ok();
        let status_text;
        let toggle_text;
        let tooltip;
        // warn/closing/auto_open are read after the lock block.
        let warn;
        let mut auto_open = false;
        {
            let mut st = ui.lock().unwrap();
            if healthy && st.token.is_none() {
                if let Some(v) = http_get("/bootstrap", None) {
                    st.token = v.get("token").and_then(|t| t.as_str()).map(str::to_string);
                }
            }
            if healthy {
                if let Some(t) = st.token.clone() {
                    if let Some(v) = http_get("/config", Some(&t)) {
                        if let Some(r) = v.get("recording").and_then(|r| r.as_bool()) {
                            st.recording = r;
                        }
                        st.ext = ext_of(&v);
                    }
                }
            }
            st.healthy = healthy;
            warn = healthy && is_warn(st.ext);
            // Extension missing (first install OR removed/stale) and not
            // dismissed: surface the setup window once per launch instead of
            // waiting for the user to notice the badge.
            if healthy && is_warn(st.ext) && !st.setup_prompted {
                st.setup_prompted = true;
                auto_open = true;
            }
            status_text = if !healthy {
                "Server down".to_string()
            } else if st.ext.is_none() {
                // /config answered without an extension field: the running
                // server predates the setup flow. Never silent-normal.
                "Server outdated — update & restart iRecall".to_string()
            } else if st.recording {
                "Recording — pages kept locally".to_string()
            } else {
                "Paused — not capturing".to_string()
            };
            tooltip = if warn {
                Some(if st.ext.is_some_and(|e| e.never) {
                    "iRecall — set up the Chrome extension".to_string()
                } else {
                    "iRecall — extension not checking in (Chrome closed?)".to_string()
                })
            } else if st.ext.is_none() {
                Some("iRecall — server outdated; extension state unknown".to_string())
            } else {
                None
            };
            toggle_text = if st.recording {
                "Pause Recording".to_string()
            } else {
                "Resume Recording".to_string()
            };
        }
        let closing = was_warn && !warn;
        was_warn = warn;

        // Menu/tray/window APIs are main-thread on macOS.
        let it = items.clone();
        let app_for_ui = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = it.status.set_text(status_text);
            let _ = it.toggle.set_text(toggle_text);
            // Always enabled: opening the setup window is harmless in every
            // state, and a greyed item is how "server too old for extension
            // state" used to masquerade as a dead click.
            let _ = it.setup.set_enabled(true);
            // Warning icon ships in full color (non-template) so the yellow
            // badge survives tinting on light + dark menu bars.
            let icon = if warn {
                it.icons.warn.clone()
            } else {
                it.icons.base.clone()
            };
            let _ = it.tray.set_icon(Some(icon));
            #[cfg(target_os = "macos")]
            let _ = it.tray.set_icon_as_template(!warn);
            let _ = it.tray.set_tooltip(tooltip);
            if auto_open {
                open_setup_window(&app_for_ui);
            }
            if closing {
                close_setup_window(&app_for_ui); // extension checked in — done
            }
        });
        thread::sleep(POLL_INTERVAL);
    }
}

fn request_quit(app: &AppHandle, quitting: &Arc<AtomicBool>) {
    quitting.store(true, Ordering::Relaxed);
    // The supervisor polls the flag every 200ms and SIGTERMs the node child;
    // give it a beat before the process goes away.
    thread::sleep(Duration::from_millis(350));
    app.exit(0);
}

// --- setup-window commands (called from static/setup.html) ------------------------

#[tauri::command]
fn extension_info(app: AppHandle) -> serde_json::Value {
    let ext = {
        let st = app.state::<Arc<Mutex<UiState>>>();
        let guard = st.lock().unwrap();
        guard.ext
    };
    let dir = prepare_extension_dir(&app);
    json!({
        "connected": ext.is_some_and(|e| e.connected),
        "dir": dir.map(|d| d.display().to_string()),
    })
}

#[tauri::command]
fn open_chrome_extensions() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let res = Command::new("open")
        .args(["-a", "Google Chrome", "chrome://extensions"])
        .spawn();
    #[cfg(target_os = "windows")]
    let res = Command::new("cmd")
        .args(["/C", "start", "", "chrome://extensions"])
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let res: std::io::Result<()> = Err(std::io::Error::other("unsupported platform"));
    res.map(|_| ()).map_err(|e| format!("could not open Chrome: {e}"))
}

#[tauri::command]
fn reveal_extension_dir(app: AppHandle) -> Result<(), String> {
    let Some(dir) = prepare_extension_dir(&app) else {
        return Err("extension folder not found (dev build? load the repo's extension/ folder instead)".into());
    };
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg("-R").arg(&dir).spawn();
    #[cfg(target_os = "windows")]
    let res = Command::new("explorer").arg(format!("/select,{}", dir.display())).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let res = Command::new("xdg-open").arg(&dir).spawn();
    res.map(|_| ()).map_err(|e| format!("could not reveal folder: {e}"))
}

#[tauri::command]
fn dismiss_extension_setup(app: AppHandle) -> Result<(), String> {
    let token = {
        let st = app.state::<Arc<Mutex<UiState>>>();
        let mut st = st.lock().unwrap();
        if let Some(ext) = st.ext.as_mut() {
            ext.dismissed = true; // clear the badge without waiting a poll tick
        }
        st.token.clone()
    };
    let Some(token) = token else {
        return Err("server not connected yet".into());
    };
    let ok = ureq::post(&format!("{BASE}/api/extension/dismiss"))
        .timeout(Duration::from_secs(2))
        .set("authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json")
        .send_json(json!({ "dismissed": true }))
        .is_ok();
    if ok {
        Ok(())
    } else {
        Err("could not save the dismissal".into())
    }
}

#[tauri::command]
fn close_setup_window_cmd(app: AppHandle) {
    close_setup_window(&app);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            extension_info,
            open_chrome_extensions,
            reveal_extension_dir,
            dismiss_extension_setup,
            close_setup_window_cmd
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Menu-bar-only app (Swift tray was LSUIElement + accessory).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // The old installer registered a LaunchAgent for the tray; the
            // plugin covers start-at-login on all three OSes. Errors ignored
            // (headless/CI runs).
            use tauri_plugin_autostart::ManagerExt;
            let _ = app.autolaunch().enable();

            let ui = Arc::new(Mutex::new(UiState {
                healthy: false,
                recording: true,
                token: None,
                ext: None,
                setup_prompted: false,
            }));
            app.manage(ui.clone());
            app.manage(SupervisorPid(Mutex::new(None)));
            let quitting = Arc::new(AtomicBool::new(false));
            app.manage(QuitFlag(quitting.clone()));

            // Bundle the unpacked extension to a stable data-dir path so the
            // setup window + instructions can point at one fixed location.
            prepare_extension_dir(app.handle());

            let status = MenuItemBuilder::with_id("status", "connecting…")
                .enabled(false)
                .build(app)?;
            let toggle = MenuItemBuilder::with_id("toggle", "Pause Recording").build(app)?;
            let setup = MenuItemBuilder::with_id("setup", "Set Up Chrome Extension…").build(app)?;
            let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit iRecall").build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&status, &toggle, &setup, &dashboard, &sep, &quit])
                .build()?;

            // "iR" monogram drawn as a transparent template PNG (icons/
            // tray-ir.png) — the plain title API can't size or align text, and
            // template tinting keeps it legible on light + dark menu bars.
            // tray-icon renders every icon 18pt tall; the glyph fills ~16/18.
            // tray-ir-warn.png is the same glyph on a color chip with a yellow
            // badge; it renders non-template (set in the poller) so the yellow
            // survives menu-bar tinting.
            let icons = Arc::new(Icons {
                base: tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray-ir.png"
                ))
                .expect("valid tray-ir.png"),
                warn: tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray-ir-warn.png"
                ))
                .expect("valid tray-ir-warn.png"),
            });
            let tray_icon = icons.base.clone();
            let builder =
                TrayIconBuilder::with_id("irecall-tray").menu(&menu).icon(tray_icon);
            #[cfg(target_os = "macos")]
            let builder = builder.icon_as_template(true);
            let tray = builder.build(app)?;

            let items = TrayItems {
                status,
                toggle,
                setup,
                tray,
                icons,
            };
            {
                let app = app.handle().clone();
                let quitting = quitting.clone();
                thread::spawn(move || supervisor(app, quitting));
            }
            {
                let app = app.handle().clone();
                let quitting = quitting.clone();
                let ui = ui.clone();
                let items = items.clone();
                thread::spawn(move || poller(app, quitting, ui, items));
            }

            let ui_menu = ui.clone();
            let quitting_menu = quitting.clone();
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "toggle" => {
                    let (recording, token) = {
                        let g = ui_menu.lock().unwrap();
                        (g.recording, g.token.clone())
                    };
                    if let Some(token) = token {
                        if post_config(!recording, &token) {
                            ui_menu.lock().unwrap().recording = !recording;
                        }
                    }
                }
                "setup" => open_setup_window(app),
                "dashboard" => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app.opener().open_url(BASE.to_string(), None::<&str>);
                }
                "quit" => request_quit(app, &quitting_menu),
                _ => {}
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Any exit path (not just the menu item) must stop the
                // supervisor so the node child gets its SIGTERM instead of
                // being orphaned.
                if let Some(flag) = _app.try_state::<QuitFlag>() {
                    flag.0.store(true, Ordering::Relaxed);
                }
            }
        });
}
