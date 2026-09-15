import {
  List,
  ActionPanel,
  Action,
  Icon,
  getPreferenceValues,
  showToast,
  Toast,
  confirmAlert,
  Alert,
  environment,
  Clipboard,
} from "@raycast/api";
import { useState, useEffect, useMemo, useCallback } from "react";
import { homedir } from "os";
import path from "path";
import fs from "fs";
import initSqlJs, { type Database } from "sql.js";

interface ClipboardEntry {
  id: number;
  content: string;
  content_type: string;
  source_app: string | null;
  content_hash: string;
  created_at: number;
  pinned: number;
  ocr_text: string | null;
}

interface Preferences {
  databasePath: string;
}

const PAGE_SIZE = 200;

function resolveDbPath(dbPath: string): string {
  if (dbPath.startsWith("~")) {
    return path.join(homedir(), dbPath.slice(1));
  }
  return dbPath;
}

function getIcon(contentType: string): Icon {
  switch (contentType) {
    case "url":
      return Icon.Link;
    case "email":
      return Icon.Envelope;
    case "image":
      return Icon.Image;
    case "path":
      return Icon.Finder;
    default:
      return Icon.Document;
  }
}

function getRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return "just now";
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} min ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours}h ago`;
  }
  const days = Math.floor(diff / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function getDateSection(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp * 1000);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86400000);

  if (date >= todayStart) return "Today";
  if (date >= yesterdayStart) return "Yesterday";
  if (date >= weekStart) return "This Week";
  return "Older";
}

function truncateContent(content: string, maxLen = 80): string {
  const firstLine = content.split("\n")[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "…";
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function openDb(): Promise<Database> {
  const prefs = getPreferenceValues<Preferences>();
  const dbPath = resolveDbPath(prefs.databasePath);
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(environment.assetsPath, file),
  });
  const fileBuffer = fs.readFileSync(dbPath);
  return new SQL.Database(fileBuffer);
}

function saveDb(db: Database): void {
  const prefs = getPreferenceValues<Preferences>();
  const dbPath = resolveDbPath(prefs.databasePath);
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function queryEntries(db: Database, search: string): ClipboardEntry[] {
  const terms = search
    .split(/[\s\u3000]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  // ocr_text is added by newer daemons; older databases don't have the column yet.
  const hasOcr = db
    .exec("PRAGMA table_info(clipboard)")[0]
    ?.values.some((row: unknown[]) => row[1] === "ocr_text");
  const columns = `id, content, content_type, source_app, content_hash, created_at, pinned, ${
    hasOcr ? "ocr_text" : "NULL AS ocr_text"
  }`;
  const order = "ORDER BY pinned DESC, created_at DESC LIMIT $limit";
  // OCR lines wrap mid-word in Japanese, so match against the text with newlines removed.
  const where = terms
    .map((_, i) =>
      hasOcr
        ? `(content LIKE $t${i} OR replace(ocr_text, char(10), '') LIKE $t${i})`
        : `content LIKE $t${i}`,
    )
    .join(" AND ");

  const stmt = db.prepare(
    where
      ? `SELECT ${columns} FROM clipboard WHERE ${where} ${order}`
      : `SELECT ${columns} FROM clipboard ${order}`,
  );
  const bind: Record<string, string | number> = { $limit: PAGE_SIZE };
  terms.forEach((t, i) => {
    bind[`$t${i}`] = `%${t}%`;
  });
  stmt.bind(bind);

  const rows: ClipboardEntry[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as ClipboardEntry;
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function getDetailMarkdown(entry: ClipboardEntry): string {
  const metaParts: string[] = [];
  if (entry.source_app) metaParts.push(entry.source_app);
  metaParts.push(entry.content_type);
  metaParts.push(formatTimestamp(entry.created_at));
  metaParts.push(`${entry.content.length} chars`);
  const metaLine = `\`${metaParts.join(" · ")}\``;

  if (entry.content_type === "image") {
    const ocr = entry.ocr_text ? `\n\n\`\`\`\n${entry.ocr_text}\n\`\`\`` : "";
    return `![clipboard image](file://${entry.content})${ocr}\n\n---\n${metaLine}`;
  }
  if (entry.content_type === "url") {
    return `[${entry.content}](${entry.content})\n\n---\n${metaLine}`;
  }
  return `\`\`\`\n${entry.content}\n\`\`\`\n\n---\n${metaLine}`;
}

interface GroupedSection {
  title: string;
  entries: ClipboardEntry[];
}

export default function SearchClipboardVault() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async (search: string) => {
    setIsLoading(true);
    try {
      const db = await openDb();
      const rows = queryEntries(db, search);
      db.close();
      setEntries(rows);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEntries(searchText);
  }, [searchText, loadEntries]);

  const bumpEntry = useCallback(
    async (entryId: number) => {
      try {
        const db = await openDb();
        const now = Math.floor(Date.now() / 1000);
        db.run("UPDATE clipboard SET created_at = $ts WHERE id = $id", {
          $ts: now,
          $id: entryId,
        });
        saveDb(db);
        db.close();
        await loadEntries(searchText);
      } catch (e) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to update entry",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [searchText, loadEntries],
  );

  const grouped = useMemo(() => {
    const pinnedEntries: ClipboardEntry[] = [];
    const unpinned: ClipboardEntry[] = [];
    for (const entry of entries) {
      if (entry.pinned) {
        pinnedEntries.push(entry);
      } else {
        unpinned.push(entry);
      }
    }

    const sections: GroupedSection[] = [];
    if (pinnedEntries.length > 0) {
      sections.push({ title: "Pinned", entries: pinnedEntries });
    }

    const dateSections: Record<string, ClipboardEntry[]> = {};
    const order = ["Today", "Yesterday", "This Week", "Older"];
    for (const entry of unpinned) {
      const section = getDateSection(entry.created_at);
      if (!dateSections[section]) dateSections[section] = [];
      dateSections[section].push(entry);
    }
    for (const s of order) {
      if (dateSections[s]) {
        sections.push({ title: s, entries: dateSections[s] });
      }
    }
    return sections;
  }, [entries]);

  const togglePin = useCallback(
    async (entry: ClipboardEntry) => {
      try {
        const db = await openDb();
        const newPinned = entry.pinned ? 0 : 1;
        db.run("UPDATE clipboard SET pinned = $pinned WHERE id = $id", {
          $pinned: newPinned,
          $id: entry.id,
        });
        saveDb(db);
        db.close();
        await showToast({ style: Toast.Style.Success, title: newPinned ? "Pinned" : "Unpinned" });
        loadEntries(searchText);
      } catch (e) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to update pin",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [searchText, loadEntries],
  );

  const deleteEntry = useCallback(
    async (entry: ClipboardEntry) => {
      const confirmed = await confirmAlert({
        title: "Delete Entry",
        message: "Are you sure you want to delete this clipboard entry?",
        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) return;
      try {
        const db = await openDb();
        db.run("DELETE FROM clipboard WHERE id = $id", { $id: entry.id });
        saveDb(db);
        db.close();
        await showToast({ style: Toast.Style.Success, title: "Deleted" });
        loadEntries(searchText);
      } catch (e) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to delete",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [searchText, loadEntries],
  );

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Database Error"
          description={error}
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search clipboard history…"
      onSearchTextChange={setSearchText}
      isShowingDetail
      throttle
    >
      {!isLoading && entries.length === 0 && (
        <List.EmptyView
          icon={Icon.Clipboard}
          title="No Clipboard Entries"
          description={searchText ? "No entries match your search" : "Copy something to get started — your clipboard history will appear here."}
        />
      )}
      {grouped.map((section) => (
        <List.Section key={section.title} title={section.title}>
          {section.entries.map((entry) => {
            const subtitle = [entry.source_app, getRelativeTime(entry.created_at)]
              .filter(Boolean)
              .join(" · ");

            return (
              <List.Item
                key={entry.id}
                icon={entry.pinned ? Icon.Pin : getIcon(entry.content_type)}
                title={
                  entry.content_type === "image"
                    ? entry.ocr_text
                      ? truncateContent(entry.ocr_text)
                      : "Image"
                    : truncateContent(entry.content)
                }
                accessories={[{ text: subtitle }]}
                detail={
                  <List.Item.Detail markdown={getDetailMarkdown(entry)} />
                }
                actions={
                  <ActionPanel>
                    {entry.content_type === "image" ? (
                      <Action
                        title="Copy Image"
                        icon={Icon.Image}
                        onAction={async () => {
                          await Clipboard.copy({ file: entry.content });
                          await showToast({ style: Toast.Style.Success, title: "Image copied" });
                          await bumpEntry(entry.id);
                        }}
                      />
                    ) : (
                      <Action
                        title="Paste to Active App"
                        icon={Icon.Document}
                        onAction={async () => {
                          await Clipboard.paste(entry.content);
                          await bumpEntry(entry.id);
                        }}
                      />
                    )}
                    <Action
                      title="Copy to Clipboard"
                      icon={Icon.CopyClipboard}
                      shortcut={{ modifiers: ["cmd"], key: "return" }}
                      onAction={async () => {
                        if (entry.content_type === "image") {
                          await Clipboard.copy({ file: entry.content });
                        } else {
                          await Clipboard.copy(entry.content);
                        }
                        await showToast({ style: Toast.Style.Success, title: "Copied" });
                        await bumpEntry(entry.id);
                      }}
                    />
                    {entry.content_type === "image" && entry.ocr_text && (
                      <Action
                        title="Copy OCR Text"
                        icon={Icon.Text}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
                        onAction={async () => {
                          await Clipboard.copy(entry.ocr_text ?? "");
                          await showToast({ style: Toast.Style.Success, title: "OCR text copied" });
                        }}
                      />
                    )}
                    {entry.content_type === "url" && (
                      <Action.OpenInBrowser
                        title="Open in Browser"
                        url={entry.content}
                        shortcut={{ modifiers: ["cmd"], key: "o" }}
                      />
                    )}
                    {entry.content_type === "path" && (
                      <Action.Open
                        title="Open in Finder"
                        target={entry.content}
                        shortcut={{ modifiers: ["cmd"], key: "o" }}
                      />
                    )}
                    <Action
                      title={entry.pinned ? "Unpin Entry" : "Pin Entry"}
                      icon={Icon.Pin}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                      onAction={() => togglePin(entry)}
                    />
                    <Action
                      title="Delete Entry"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                      onAction={() => deleteEntry(entry)}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}
