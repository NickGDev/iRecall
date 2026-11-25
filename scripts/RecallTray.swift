// Recall tray app — menu-bar status + control, and supervisor for the local
// recall server. Compiled by scripts/build-app.sh into Recall.app; the server
// runs as a child (Contents/MacOS/node on Resources/app/server/dist/main.js)
// with its DB + token in ~/Library/Application Support/Recall, so quitting the
// tray quits everything and a crashed server respawns automatically.
import AppKit

let base = URL(string: "http://127.0.0.1:8787")!

final class Tray: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var toggleItem: NSMenuItem!
    private var healthy = false
    private var recording = true
    private var token: String?
    private var server: Process?
    private var quitting = false

    func applicationDidFinishLaunching(_: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        statusLine = NSMenuItem(title: "connecting…", action: nil, keyEquivalent: "")
        toggleItem = NSMenuItem(title: "Pause Recording", action: #selector(toggleRecording), keyEquivalent: "")
        let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        let quit = NSMenuItem(title: "Quit Recall", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(statusLine)
        menu.addItem(toggleItem)
        menu.addItem(dashboard)
        menu.addItem(.separator())
        menu.addItem(quit)
        [toggleItem, dashboard].forEach { $0.target = self }
        item.menu = menu

        startServer()
        refresh()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
    }

    func applicationWillTerminate(_: Notification) {
        quitting = true
        guard let server = server, server.isRunning else { return }
        server.interrupt() // SIGTERM — node exits, SQLite WAL checkpoints
    }

    // --- server supervision ------------------------------------------------------

    private lazy var appSupportDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Recall", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private func startServer() {
        guard !quitting,
              let res = Bundle.main.resourceURL?.appendingPathComponent("app", isDirectory: true),
              let node = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("node")
        else { return }
        let logPath = appSupportDir.appendingPathComponent("server.log")
        if !FileManager.default.fileExists(atPath: logPath.path) {
            FileManager.default.createFile(atPath: logPath.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let log = try? FileHandle(forWritingTo: logPath) else { return }
        let _ = try? log.seekToEnd()

        let proc = Process()
        proc.executableURL = node
        proc.arguments = ["--max-old-space-size=384", "dist/main.js"]
        proc.currentDirectoryURL = res.appendingPathComponent("server", isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        env["RECALL_DB_PATH"] = appSupportDir.appendingPathComponent("recall.db").path
        env["RECALL_TOKEN_PATH"] = appSupportDir.appendingPathComponent(".token").path
        proc.environment = env
        proc.standardOutput = log
        proc.standardError = log
        proc.terminationHandler = { [weak self] _ in
            // KeepAlive parity: fixed 3s gap, respawn until the app quits.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.startServer() }
        }
        do {
            try proc.run()
            server = proc
        } catch {
            fputs("recall: server spawn failed: \(error)\n", stderr)
        }
    }

    private func refresh() {
        let healthReq = URLRequest(url: base.appendingPathComponent("health"))
        URLSession.shared.dataTask(with: healthReq) { [weak self] data, _, _ in
            let ok = data != nil
            DispatchQueue.main.async { self?.healthy = ok; self?.render() }
        }.resume()
        if token == nil { fetchToken() }
        if let token = token { fetchConfig(token) }
    }

    private func fetchToken() {
        let req = URLRequest(url: base.appendingPathComponent("bootstrap"))
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let t = obj["token"] as? String else { return }
            DispatchQueue.main.async { self?.token = t; self?.fetchConfig(t) }
        }.resume()
    }

    private func fetchConfig(_ token: String) {
        var req = URLRequest(url: base.appendingPathComponent("config"))
        req.setValue("Bearer " + token, forHTTPHeaderField: "authorization")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rec = obj["recording"] as? Bool else { return }
            DispatchQueue.main.async { self?.recording = rec; self?.render() }
        }.resume()
    }

    @objc private func toggleRecording() {
        guard let token = token else { return }
        var req = URLRequest(url: base.appendingPathComponent("config"))
        req.httpMethod = "POST"
        req.setValue("Bearer " + token, forHTTPHeaderField: "authorization")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["recording": !recording])
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(base)
    }

    private func render() {
        // White "R" monogram: white while recording, dimmed when paused,
        // gray when the server is unreachable. Menu text carries the details.
        let color: NSColor
        if !healthy { color = .systemGray }
        else if recording { color = .white }
        else { color = NSColor.white.withAlphaComponent(0.35) }
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        item.button?.attributedTitle = NSAttributedString(
            string: "R",
            attributes: [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: color, .paragraphStyle: para]
        )
        statusLine.title = !healthy
            ? "Server down"
            : (recording ? "Recording — pages kept locally" : "Paused — not capturing")
        toggleItem.title = recording ? "Pause Recording" : "Resume Recording"
    }
}

let app = NSApplication.shared
let delegate = Tray()
app.delegate = delegate
app.run()
