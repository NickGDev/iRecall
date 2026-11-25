// Recall tray app — menu-bar status + control for the local recall server.
// Compiled by scripts/install-mac.sh into Recall.app/Contents/MacOS/Recall.
import AppKit

let base = URL(string: "http://127.0.0.1:8787")!

final class Tray: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var toggleItem: NSMenuItem!
    private var healthy = false
    private var recording = true
    private var token: String?

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

        refresh()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
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
