const path = require('path');

const sqlitePath = process.env.SQLITE_DB_PATH ? path.resolve(process.env.SQLITE_DB_PATH) : null;

let sqliteDisabled = false;
let sqliteLib = null;
let sqliteDb = null;
let sqliteInitPromise = null;
let loggedReady = false;

function loadSqliteLib() {
  if (sqliteLib || sqliteDisabled || !sqlitePath) return sqliteLib;
  try {
    // eslint-disable-next-line global-require
    sqliteLib = require('sqlite3');
    if (sqliteLib && typeof sqliteLib.verbose === 'function') {
      sqliteLib = sqliteLib.verbose();
    }
    return sqliteLib;
  } catch (err) {
    console.warn('SQLite support requested but sqlite3 module is not installed.');
    sqliteDisabled = true;
    return null;
  }
}

function openDatabase(sqlite3) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(sqlitePath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(db);
      }
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function normalizeConversationRef(ref) {
  if (!ref) return { key: null, id: null, name: null };

  if (typeof ref === 'string') {
    const trimmed = ref.trim();
    return { key: trimmed || null, id: null, name: null };
  }

  if (typeof ref === 'object') {
    const { key, id, name } = ref;
    return {
      key: (key && String(key).trim()) || (id && String(id).trim()) || (name && String(name).trim()) || null,
      id: id ? String(id).trim() : null,
      name: name ? String(name).trim() : null
    };
  }

  return { key: String(ref).trim(), id: null, name: null };
}

async function initDatabase() {
  if (!sqlitePath || sqliteDisabled) return null;
  if (sqliteDb) return sqliteDb;
  if (!sqliteInitPromise) {
    sqliteInitPromise = (async () => {
      try {
        const sqlite3 = loadSqliteLib();
        if (!sqlite3) return null;
        const db = await openDatabase(sqlite3);
        await exec(
          db,
          `CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_key TEXT NOT NULL,
            conversation_id TEXT,
            conversation_name TEXT,
            sender TEXT,
            text TEXT NOT NULL,
            logged_at TEXT NOT NULL DEFAULT (datetime('now'))
          );`
        );
        await exec(
          db,
          `CREATE INDEX IF NOT EXISTS idx_messages_conversation
            ON messages(conversation_key, logged_at);`
        );
        sqliteDb = db;
        if (!loggedReady) {
          console.log(`SQLite logging enabled (${sqlitePath})`);
          loggedReady = true;
        }
        return db;
      } catch (err) {
        sqliteDisabled = true;
        console.error('Failed to initialize SQLite logging, disabling feature.', err);
        return null;
      }
    })();
  }
  return sqliteInitPromise;
}

async function persistMessages(conversationRef, messages) {
  if (!sqlitePath || sqliteDisabled) return false;
  if (!messages || !messages.length) return false;
  const normalizedConversation = normalizeConversationRef(conversationRef);
  if (!normalizedConversation.key) return false;

  try {
    const db = await initDatabase();
    if (!db) return false;

    for (const message of messages) {
      if (!message || !message.text) continue;
      await run(
        db,
        `INSERT INTO messages (conversation_key, conversation_id, conversation_name, sender, text)
         VALUES (?, ?, ?, ?, ?)`,
        [
          normalizedConversation.key,
          normalizedConversation.id,
          normalizedConversation.name,
          message.sender || null,
          message.text
        ]
      );
    }
    return true;
  } catch (err) {
    console.error('Failed to persist messages to SQLite', err);
    return false;
  }
}

module.exports = { persistMessages };
