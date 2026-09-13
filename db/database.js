const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'booth.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    state TEXT,
    photo_count INTEGER,
    frame TEXT,
    print_copies INTEGER,
    print_status TEXT,
    upload_status TEXT,
    photo_url TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`);

const upsertStmt = db.prepare(`
  INSERT INTO sessions (id, state, photo_count, frame, print_copies, print_status, upload_status, photo_url, created_at, updated_at)
  VALUES (@id, @state, @photoCount, @frame, @printCopies, @print, @uploadStatus, @photoUrl, @createdAt, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    state = excluded.state,
    photo_count = excluded.photo_count,
    frame = excluded.frame,
    print_copies = excluded.print_copies,
    print_status = excluded.print_status,
    upload_status = excluded.upload_status,
    photo_url = excluded.photo_url,
    updated_at = excluded.updated_at
`);

function saveSession(session) {
  upsertStmt.run({
    id: session.id,
    state: session.state,
    photoCount: session.photoCount,
    frame: session.frame,
    printCopies: session.printCopies,
    print: session.print,
    uploadStatus: session.uploadStatus,
    photoUrl: session.photoUrl,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  });
}

module.exports = { saveSession };
