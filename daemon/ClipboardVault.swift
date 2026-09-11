import Cocoa
import SQLite3
import Foundation

// MARK: - SQLite Wrapper

class ClipboardDB {
    private var db: OpaquePointer?
    let dbPath: String

    init(path: String) {
        self.dbPath = path
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        
        guard sqlite3_open(path, &db) == SQLITE_OK else {
            fatalError("Cannot open database at \(path)")
        }
        createTable()
    }

    deinit {
        sqlite3_close(db)
    }

    private func createTable() {
        let sql = """
        CREATE TABLE IF NOT EXISTS clipboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            source_app TEXT,
            content_hash TEXT NOT NULL,
            created_at REAL NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_clipboard_created_at ON clipboard(created_at);
        CREATE INDEX IF NOT EXISTS idx_clipboard_content_hash ON clipboard(content_hash);
        CREATE INDEX IF NOT EXISTS idx_clipboard_content ON clipboard(content);
        """
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errMsg) != SQLITE_OK {
            let err = errMsg.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(errMsg)
            print("Warning: table creation issue: \(err)")
        }
    }

    func isDuplicate(hash: String) -> Bool {
        let sql = "SELECT COUNT(*) FROM clipboard WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1"
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        sqlite3_bind_text(stmt, 1, (hash as NSString).utf8String, -1, nil)
        if sqlite3_step(stmt) == SQLITE_ROW {
            return sqlite3_column_int(stmt, 0) > 0
        }
        return false
    }

    func insert(content: String, contentType: String, sourceApp: String?, hash: String) {
        let sql = "INSERT INTO clipboard (content, content_type, source_app, content_hash, created_at) VALUES (?, ?, ?, ?, ?)"
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        sqlite3_bind_text(stmt, 1, (content as NSString).utf8String, -1, nil)
        sqlite3_bind_text(stmt, 2, (contentType as NSString).utf8String, -1, nil)
        if let app = sourceApp {
            sqlite3_bind_text(stmt, 3, (app as NSString).utf8String, -1, nil)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        sqlite3_bind_text(stmt, 4, (hash as NSString).utf8String, -1, nil)
        sqlite3_bind_double(stmt, 5, Date().timeIntervalSince1970)
        sqlite3_step(stmt)
    }

    func entryCount() -> Int {
        let sql = "SELECT COUNT(*) FROM clipboard"
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
        if sqlite3_step(stmt) == SQLITE_ROW {
            return Int(sqlite3_column_int(stmt, 0))
        }
        return 0
    }
}

// MARK: - Clipboard Monitor

class ClipboardMonitor {
    private let db: ClipboardDB
    private let pasteboard = NSPasteboard.general
    private var lastChangeCount: Int
    private let excludedApps: Set<String>
    private let pollInterval: TimeInterval = 0.5

    init(db: ClipboardDB, excludedApps: Set<String> = []) {
        self.db = db
        self.excludedApps = excludedApps
        self.lastChangeCount = pasteboard.changeCount
    }

    func start() {
        print("ClipboardVault daemon started (poll interval: \(pollInterval)s)")
        print("Database entries: \(db.entryCount())")
        print("Excluded apps: \(excludedApps.isEmpty ? "none" : excludedApps.joined(separator: ", "))")
        
        let timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.checkClipboard()
        }
        timer.tolerance = 0.1
        RunLoop.current.run()
    }

    private func checkClipboard() {
        let currentCount = pasteboard.changeCount
        guard currentCount != lastChangeCount else { return }
        lastChangeCount = currentCount

        // Get frontmost app
        let sourceApp = NSWorkspace.shared.frontmostApplication?.localizedName

        // Skip excluded apps
        if let app = sourceApp, excludedApps.contains(app) {
            return
        }

        // Skip content marked concealed/transient by the source app (password managers)
        let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
        let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
        if let types = pasteboard.types, types.contains(concealed) || types.contains(transient) {
            return
        }

        // Read image content (check before text — screenshots often have both)
        if let tiffData = pasteboard.data(forType: .tiff) {
            let hash = simpleHashData(tiffData)
            if !db.isDuplicate(hash: hash) {
                if let bitmapRep = NSBitmapImageRep(data: tiffData),
                   let pngData = bitmapRep.representation(using: .png, properties: [:]) {
                    let imagesDir = (db.dbPath as NSString).deletingLastPathComponent + "/images"
                    try? FileManager.default.createDirectory(atPath: imagesDir, withIntermediateDirectories: true)
                    let filename = "\(hash).png"
                    let filepath = imagesDir + "/" + filename
                    try? pngData.write(to: URL(fileURLWithPath: filepath))
                    db.insert(content: filepath, contentType: "image", sourceApp: sourceApp, hash: hash)
                }
            }
            return  // Don't also capture text representation of images
        }

        // Read text content
        if let text = pasteboard.string(forType: .string), !text.isEmpty {
            let hash = simpleHash(text)
            if !db.isDuplicate(hash: hash) {
                let contentType = detectContentType(text)
                db.insert(content: text, contentType: contentType, sourceApp: sourceApp, hash: hash)
            }
        }
    }

    private func detectContentType(_ text: String) -> String {
        if text.hasPrefix("http://") || text.hasPrefix("https://") {
            return "url"
        }
        if text.hasPrefix("/") && FileManager.default.fileExists(atPath: text) {
            return "path"
        }
        if text.contains("@") && text.contains(".") && !text.contains(" ") {
            return "email"
        }
        return "text"
    }

    private func simpleHash(_ string: String) -> String {
        var hash: UInt64 = 5381
        for byte in string.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        return String(hash, radix: 16)
    }

    private func simpleHashData(_ data: Data) -> String {
        var hash: UInt64 = 5381
        for byte in data.prefix(8192) {  // Hash first 8KB for speed
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        // Include total size to differentiate similar-prefix files
        hash = ((hash << 5) &+ hash) &+ UInt64(data.count)
        return String(hash, radix: 16)
    }
}

// MARK: - Config

struct Config {
    let dbPath: String
    let excludedApps: Set<String>

    static func load() -> Config {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let configPath = "\(home)/.clipboard-vault/config.json"
        let defaultDBPath = "\(home)/.clipboard-vault/clipboard.db"

        if let data = FileManager.default.contents(atPath: configPath),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let dbPath = json["dbPath"] as? String ?? defaultDBPath
            let excluded = json["excludedApps"] as? [String] ?? ["Keychain Access", "1Password", "Bitwarden"]
            return Config(dbPath: dbPath, excludedApps: Set(excluded))
        }

        // Write default config
        let defaultConfig: [String: Any] = [
            "dbPath": defaultDBPath,
            "excludedApps": ["Keychain Access", "1Password", "Bitwarden"]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: defaultConfig, options: .prettyPrinted) {
            let dir = (configPath as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: configPath))
        }

        return Config(dbPath: defaultDBPath, excludedApps: ["Keychain Access", "1Password", "Bitwarden"])
    }
}

// MARK: - Main

let config = Config.load()
let db = ClipboardDB(path: config.dbPath)
let monitor = ClipboardMonitor(db: db, excludedApps: config.excludedApps)

signal(SIGTERM) { _ in
    print("ClipboardVault daemon stopping...")
    exit(0)
}
signal(SIGINT) { _ in
    print("ClipboardVault daemon stopping...")
    exit(0)
}

monitor.start()
