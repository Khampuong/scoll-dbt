// ฐานข้อมูล SQLite (ใช้โมดูล node:sqlite ที่มากับ Node.js ไม่ต้องติดตั้งเพิ่ม)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'score.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'judge')),
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL,
    school TEXT    NOT NULL DEFAULT '',
    sort   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS scores (
    judge_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    item_id    TEXT    NOT NULL,
    value      REAL    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (judge_id, team_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS saved (
    judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    saved_at TEXT    NOT NULL,
    PRIMARY KEY (judge_id, team_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const DEFAULT_INFO = {
  title: 'การแข่งขันทักษะวิชาชีพ',
  lines: [
    'ประเภทวิชาอุตสาหกรรมดิจิทัลและเทคโนโลยีสารสนเทศ',
    'กลุ่มอาชีพธุรกิจดิจิทัลและพาณิชอิเล็กทรอนิกส์ สาขาวิชาเทคโนโลยีธุรกิจดิจิทัล ทักษะการพัฒนานวัตกรรมเทคโนโลยีธุรกิจดิจิทัล',
    'ระดับประกาศนียบัตรวิชาชีพชั้นสูง (ปวส.) ระดับจังหวัด (อาชีวศึกษากรุงเทพมหานคร) ปีการศึกษา 2569',
  ],
  date: '',
  venue: '',
};

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ข้อมูลเริ่มต้นเมื่อเปิดใช้งานครั้งแรก: ผู้ดูแลระบบ 1 บัญชี + ทีมตัวอย่าง 3 ทีม
function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUsers) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, 'ผู้ดูแลระบบ', 'admin')")
      .run(username, bcrypt.hashSync(password, 10));
    console.log('\n==============================================');
    console.log(' สร้างบัญชีผู้ดูแลระบบแล้ว');
    console.log(`   ชื่อผู้ใช้: ${username}`);
    console.log(`   รหัสผ่าน : ${generated ? password : '(ตามค่า ADMIN_PASSWORD)'}`);
    console.log(' เข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านที่แท็บ "ตั้งค่า"');
    console.log('==============================================\n');
  }
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'info'").get()) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('info', ?)").run(JSON.stringify(DEFAULT_INFO));
    const ins = db.prepare('INSERT INTO teams (name, sort) VALUES (?, ?)');
    [1, 2, 3].forEach((n) => ins.run(`ทีมที่ ${n}`, n));
  }
}
seed();

module.exports = { db, tx, DEFAULT_INFO };
