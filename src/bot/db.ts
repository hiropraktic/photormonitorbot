import Database from "better-sqlite3";
import path from "path";

const db = new Database(path.join(process.cwd(), "bot.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS keywords (
    keyword TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS sources (
    channel_id TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT,
    source_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export const getTargetChannel = () => {
  const row = db.prepare("SELECT value FROM config WHERE key = 'target_channel'").get() as { value: string } | undefined;
  return row?.value || "";
};

export const setTargetChannel = (channelId: string) => {
  const cleanId = channelId.replace(/['"`\s]/g, '');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('target_channel', ?)").run(cleanId);
};

export const addKeyword = (keyword: string) => {
  const cleanKeyword = keyword.trim().toLowerCase();
  db.prepare("INSERT OR IGNORE INTO keywords (keyword) VALUES (?)").run(cleanKeyword);
};

export const removeKeyword = (keyword: string) => {
  const cleanKeyword = keyword.trim().toLowerCase();
  db.prepare("DELETE FROM keywords WHERE keyword = ?").run(cleanKeyword);
};

export const clearKeywords = () => {
  db.prepare("DELETE FROM keywords").run();
};

export const getKeywords = () => {
  return (db.prepare("SELECT keyword FROM keywords").all() as { keyword: string }[]).map(r => r.keyword);
};

export const addSource = (channelId: string) => {
  const cleanId = channelId.replace(/['"`\s]/g, '');
  db.prepare("INSERT OR IGNORE INTO sources (channel_id) VALUES (?)").run(cleanId);
};

export const removeSource = (channelId: string) => {
  const cleanId = channelId.replace(/['"`\s]/g, '');
  db.prepare("DELETE FROM sources WHERE channel_id = ?").run(cleanId);
};

export const clearSources = () => {
  db.prepare("DELETE FROM sources").run();
};

export const getSources = () => {
  return (db.prepare("SELECT channel_id FROM sources").all() as { channel_id: string }[]).map(r => r.channel_id);
};

export const logMatch = (keyword: string, sourceId: string) => {
  db.prepare("INSERT INTO matches (keyword, source_id) VALUES (?, ?)").run(keyword, sourceId);
};

export const getStats = () => {
  const stats = db.prepare(`
    SELECT keyword, source_id, COUNT(*) as count 
    FROM matches 
    WHERE timestamp >= datetime('now', '-24 hours')
    GROUP BY keyword, source_id
  `).all() as { keyword: string, source_id: string, count: number }[];
  return stats;
};

export const cleanDatabase = () => {
  // Clean sources
  const sources = db.prepare("SELECT channel_id FROM sources").all() as { channel_id: string }[];
  for (const s of sources) {
    const cleanId = s.channel_id.replace(/['"`\s]/g, '');
    if (cleanId !== s.channel_id) {
      db.prepare("DELETE FROM sources WHERE channel_id = ?").run(s.channel_id);
      db.prepare("INSERT OR IGNORE INTO sources (channel_id) VALUES (?)").run(cleanId);
    }
  }
  
  // Clean keywords
  const keywords = db.prepare("SELECT keyword FROM keywords").all() as { keyword: string }[];
  for (const k of keywords) {
    const cleanKeyword = k.keyword.trim().toLowerCase();
    if (cleanKeyword !== k.keyword) {
      db.prepare("DELETE FROM keywords WHERE keyword = ?").run(k.keyword);
      db.prepare("INSERT OR IGNORE INTO keywords (keyword) VALUES (?)").run(cleanKeyword);
    }
  }

  // Clean target channel
  const target = getTargetChannel();
  if (target) {
    const cleanTarget = target.replace(/['"`\s]/g, '');
    if (cleanTarget !== target) {
      setTargetChannel(cleanTarget);
    }
  }
};

export default db;
