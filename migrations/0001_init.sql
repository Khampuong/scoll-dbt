-- ฐานข้อมูล Cloudflare D1 (SQLite) — โครงสร้างเดียวกับ server/db.js
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

-- นับการเข้าสู่ระบบ/ค้นหาเบอร์ที่ผิด ต่อ IP (กันการไล่สุ่มเบอร์)
CREATE TABLE IF NOT EXISTS login_failures (
  ip    TEXT    PRIMARY KEY,
  first INTEGER NOT NULL,
  count INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('info', '{"title":"การแข่งขันทักษะวิชาชีพ","lines":["ประเภทวิชาอุตสาหกรรมดิจิทัลและเทคโนโลยีสารสนเทศ","กลุ่มอาชีพธุรกิจดิจิทัลและพาณิชอิเล็กทรอนิกส์ สาขาวิชาเทคโนโลยีธุรกิจดิจิทัล ทักษะการพัฒนานวัตกรรมเทคโนโลยีธุรกิจดิจิทัล","ระดับประกาศนียบัตรวิชาชีพชั้นสูง (ปวส.) ระดับจังหวัด (อาชีวศึกษากรุงเทพมหานคร) ปีการศึกษา 2569"],"date":"","venue":""}');
INSERT INTO teams (name, sort) SELECT 'ทีมที่ 1', 1 WHERE NOT EXISTS (SELECT 1 FROM teams);
INSERT INTO teams (name, sort) SELECT 'ทีมที่ 2', 2 WHERE (SELECT COUNT(*) FROM teams) = 1;
INSERT INTO teams (name, sort) SELECT 'ทีมที่ 3', 3 WHERE (SELECT COUNT(*) FROM teams) = 2;
