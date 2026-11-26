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
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry};

const BASE: &str = "http://127.0.0.1:8787";
const RESPAWN_DELAY: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_secs(5);

struct UiState {
    healthy: bool,
    recording: bool,
    token: Option<String>,
}

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
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
    while !quitting.load(Ordering::Relaxed) {
        let healthy = health_ok();
        let status_text;
        let toggle_text;
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
                    }
                }
            }
            st.healthy = healthy;
            status_text = if !healthy {
                "Server down".to_string()
            } else if st.recording {
                "Recording — pages kept locally".to_string()
            } else {
                "Paused — not capturing".to_string()
            };
            toggle_text = if st.recording {
                "Pause Recording".to_string()
            } else {
                "Resume Recording".to_string()
            };
        }

        // Menu item APIs are main-thread on macOS.
        let it = items.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = it.status.set_text(status_text);
            let _ = it.toggle.set_text(toggle_text);
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

fn main() {
    tauri::Builder::default()
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
            }));
            app.manage(ui.clone());
            app.manage(SupervisorPid(Mutex::new(None)));
            let quitting = Arc::new(AtomicBool::new(false));
            app.manage(QuitFlag(quitting.clone()));

            let status = MenuItemBuilder::with_id("status", "connecting…")
                .enabled(false)
                .build(app)?;
            let toggle = MenuItemBuilder::with_id("toggle", "Pause Recording").build(app)?;
            let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit iRecall").build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&status, &toggle, &dashboard, &sep, &quit])
                .build()?;

            // "iR" monogram drawn as a transparent template PNG (icons/
            // tray-ir.png) — the plain title API can't size or align text, and
            // template tinting keeps it legible on light + dark menu bars.
            // tray-icon renders every icon 18pt tall; the glyph fills ~16/18.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-ir.png"
            ))
            .expect("valid tray-ir.png");
            let builder =
                TrayIconBuilder::with_id("irecall-tray").menu(&menu).icon(tray_icon);
            #[cfg(target_os = "macos")]
            let builder = builder.icon_as_template(true);
            builder.build(app)?;

            let items = TrayItems { status, toggle };
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
