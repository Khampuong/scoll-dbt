// เซิร์ฟเวอร์ระบบกรอกคะแนน: เข้าสู่ระบบ (session cookie) + API บันทึกคะแนนลง SQLite
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx, DEFAULT_INFO } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 7;
const COOKIE = 'sid';

// ใช้เกณฑ์ชุดเดียวกับหน้าเว็บ (public/js/criteria.js) เพื่อตรวจคะแนนเต็มของแต่ละข้อ
const { CRITERIA } = require('../public/js/criteria.js');
const ITEM_MAX = Object.fromEntries(CRITERIA.flatMap((s) => s.groups.flatMap((g) => g.items)).map((i) => [i.id, i.max]));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));

// ---------- Session ----------
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`);
}

const findSession = db.prepare(`
  SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ? AND s.expires_at > ?`);

app.use((req, res, next) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.token = token;
  req.user = token ? findSession.get(token, Date.now()) : undefined;
  next();
});

const needLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' }));
const needAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ' }));
const needJudge = (req, res, next) => (req.user?.role === 'judge' ? next() : res.status(403).json({ error: 'เฉพาะกรรมการ' }));

// ลำดับกรรมการ (กรรมการคนที่ 1, 2, …) ตามลำดับในหน้าตั้งค่าของผู้ดูแลระบบ
function judgeNo(id) {
  const ids = db.prepare("SELECT id FROM users WHERE role = 'judge' ORDER BY sort, id").all().map((r) => r.id);
  return ids.indexOf(Number(id)) + 1;
}

const publicUser = (u) => ({
  id: String(u.id), username: u.username, name: u.name, role: u.role,
  ...(u.role === 'judge' ? { no: judgeNo(u.id) } : {}),
});

// ป้องกันการเดารหัสผ่าน: ผิดเกิน 10 ครั้งใน 10 นาที (ต่อ IP) ต้องรอ
const failures = new Map();
const FAIL_WINDOW = 10 * 60 * 1000, FAIL_LIMIT = 10;
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) { failures.delete(ip); return false; }
  return f.count >= FAIL_LIMIT;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------- Auth API ----------
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'เข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 10 นาที' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  // กรรมการ: เข้าสู่ระบบด้วยเบอร์โทรศัพท์อย่างเดียว (ไม่ใช้รหัสผ่าน)
  const phone = normPhone(username);
  let user = PHONE_RE.test(phone)
    ? db.prepare("SELECT * FROM users WHERE username = ? AND role = 'judge'").get(phone) : undefined;
  if (!user) {
    // ผู้ดูแลระบบ: ชื่อผู้ใช้ + รหัสผ่าน
    const admin = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      recordFailure(ip);
      return res.status(401).json({
        error: PHONE_RE.test(phone) ? `ไม่พบเบอร์ ${phone} ในระบบ — ตรวจสอบเบอร์ หรือติดต่อผู้ดูแลระบบ` : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
      });
    }
    user = admin;
  }
  failures.delete(ip);
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + maxAge * 1000);
  setSessionCookie(req, res, token, maxAge);
}

// หน้าเข้าสู่ระบบ: พิมพ์เบอร์โทรแล้วแสดงชื่อกรรมการเจ้าของเบอร์ (นับเป็นการลองผิดถ้าไม่พบ เพื่อกันการไล่สุ่มเบอร์)
app.get('/api/lookup', (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาที' });
  const phone = normPhone(req.query.phone);
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: PHONE_ERR });
  const j = db.prepare("SELECT id, name FROM users WHERE username = ? AND role = 'judge'").get(phone);
  if (!j) { recordFailure(ip); return res.json({ found: false, phone }); }
  res.json({ found: true, phone, name: j.name, no: judgeNo(j.id) });
});

app.post('/api/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

app.post('/api/me/password', needLogin, needAdmin, (req, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), row.password_hash)) return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), req.user.id);
  // ออกจากระบบอุปกรณ์อื่นทั้งหมด ยกเว้นเครื่องนี้
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
  res.json({ ok: true });
});

// ---------- State ----------
function getInfo() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'info'").get();
  return row ? JSON.parse(row.value) : DEFAULT_INFO;
}

function buildState(user) {
  const isAdmin = user.role === 'admin';
  const judges = db.prepare("SELECT id, username, name FROM users WHERE role = 'judge' ORDER BY sort, id").all()
    .map((j) => ({ id: String(j.id), name: j.name, ...(isAdmin ? { username: j.username } : {}) }));
  const teams = db.prepare('SELECT id, name, school FROM teams ORDER BY sort, id').all()
    .map((t) => ({ id: String(t.id), name: t.name, school: t.school }));

  // กรรมการเห็นเฉพาะคะแนนของตัวเอง ผู้ดูแลระบบเห็นทั้งหมด
  const where = isAdmin ? '' : ' WHERE judge_id = ?';
  const args = isAdmin ? [] : [user.id];
  const scores = {}, saved = {};
  for (const r of db.prepare(`SELECT judge_id, team_id, item_id, value FROM scores${where}`).all(...args)) {
    ((scores[r.judge_id] ??= {})[r.team_id] ??= {})[r.item_id] = r.value;
  }
  for (const r of db.prepare(`SELECT judge_id, team_id, saved_at FROM saved${where}`).all(...args)) {
    (saved[r.judge_id] ??= {})[r.team_id] = r.saved_at;
  }
  return { info: getInfo(), judges, teams, scores, saved };
}

app.get('/api/state', needLogin, (req, res) => res.json({ user: publicUser(req.user), ...buildState(req.user) }));

// ---------- Scores (กรรมการบันทึกคะแนนของตัวเองเท่านั้น) ----------
const teamExists = (id) => !!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id);
const isSaved = (j, t) => !!db.prepare('SELECT 1 FROM saved WHERE judge_id = ? AND team_id = ?').get(j, t);

// body: { values: { "1.1": 2, "1.2": null, ... } }  (null = ลบคะแนนข้อนั้น)
app.patch('/api/scores/:teamId', needLogin, needJudge, (req, res) => {
  const teamId = Number(req.params.teamId), judgeId = req.user.id;
  if (!teamExists(teamId)) return res.status(404).json({ error: 'ไม่พบทีมนี้' });
  if (isSaved(judgeId, teamId)) return res.status(409).json({ error: 'บันทึกแล้ว — กด "แก้ไข" ก่อนเปลี่ยนคะแนน' });
  const values = req.body?.values;
  if (!values || typeof values !== 'object') return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });

  const clean = {};
  for (const [itemId, raw] of Object.entries(values)) {
    if (!(itemId in ITEM_MAX)) return res.status(400).json({ error: `ไม่มีข้อ ${itemId}` });
    if (raw === null) { clean[itemId] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > ITEM_MAX[itemId]) {
      return res.status(400).json({ error: `คะแนนข้อ ${itemId} ต้องอยู่ระหว่าง 0–${ITEM_MAX[itemId]}` });
    }
    clean[itemId] = Math.round(v * 100) / 100;
  }
  const up = db.prepare(`INSERT INTO scores (judge_id, team_id, item_id, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (judge_id, team_id, item_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  const del = db.prepare('DELETE FROM scores WHERE judge_id = ? AND team_id = ? AND item_id = ?');
  tx(() => Object.entries(clean).forEach(([i, v]) => (v === null ? del.run(judgeId, teamId, i) : up.run(judgeId, teamId, i, v))));
  res.json({ values: clean });
});

app.delete('/api/scores/:teamId', needLogin, needJudge, (req, res) => {
  const teamId = Number(req.params.teamId);
  if (isSaved(req.user.id, teamId)) return res.status(409).json({ error: 'บันทึกแล้ว — กด "แก้ไข" ก่อนล้างคะแนน' });
  db.prepare('DELETE FROM scores WHERE judge_id = ? AND team_id = ?').run(req.user.id, teamId);
  res.json({ ok: true });
});

// ล็อก (บันทึก) / ปลดล็อก (แก้ไข) ใบคะแนนของทีม
app.post('/api/saved/:teamId', needLogin, needJudge, (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!teamExists(teamId)) return res.status(404).json({ error: 'ไม่พบทีมนี้' });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO saved (judge_id, team_id, saved_at) VALUES (?, ?, ?)
    ON CONFLICT (judge_id, team_id) DO UPDATE SET saved_at = excluded.saved_at`).run(req.user.id, teamId, at);
  res.json({ savedAt: at });
});

app.delete('/api/saved/:teamId', needLogin, needJudge, (req, res) => {
  db.prepare('DELETE FROM saved WHERE judge_id = ? AND team_id = ?').run(req.user.id, Number(req.params.teamId));
  res.json({ ok: true });
});

// ---------- Admin: ข้อมูลการแข่งขัน ทีม และบัญชีกรรมการ ----------
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

app.put('/api/info', needLogin, needAdmin, (req, res) => {
  const b = req.body || {};
  const info = {
    title: str(b.title),
    lines: Array.isArray(b.lines) ? b.lines.slice(0, 10).map((l) => str(l)) : DEFAULT_INFO.lines,
    date: str(b.date, 100),
    venue: str(b.venue),
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('info', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(info));
  res.json({ info });
});

app.post('/api/teams', needLogin, needAdmin, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS s FROM teams').get();
  const name = str(req.body?.name, 200) || `ทีมที่ ${n.n + 1}`;
  const r = db.prepare('INSERT INTO teams (name, school, sort) VALUES (?, ?, ?)').run(name, str(req.body?.school), n.s + 1);
  res.json({ team: { id: String(r.lastInsertRowid), name, school: str(req.body?.school) } });
});

app.patch('/api/teams/:id', needLogin, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'ไม่พบทีมนี้' });
  const name = req.body?.name !== undefined ? str(req.body.name, 200) : t.name;
  const school = req.body?.school !== undefined ? str(req.body.school) : t.school;
  db.prepare('UPDATE teams SET name = ?, school = ? WHERE id = ?').run(name, school, id);
  res.json({ team: { id: String(id), name, school } });
});

app.delete('/api/teams/:id', needLogin, needAdmin, (req, res) => {
  db.prepare('DELETE FROM teams WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// กรรมการใช้เบอร์โทรศัพท์เป็นชื่อผู้ใช้ (เก็บในคอลัมน์ username) — ผู้ดูแลระบบยังใช้ชื่อผู้ใช้ปกติ เช่น admin
const PHONE_RE = /^0\d{8,9}$/;
const PHONE_ERR = 'เบอร์โทรศัพท์ไม่ถูกต้อง (ตัวเลข 9–10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678)';
function normPhone(s) {
  let d = String(s ?? '').trim().replace(/[\s\-().]/g, '');
  if (/^\+?66\d{8,9}$/.test(d)) d = `0${d.replace(/^\+?66/, '')}`;
  return d;
}
const usernameTaken = (u, exceptId = 0) => !!db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u, exceptId);

// กรรมการไม่มีรหัสผ่าน (เข้าด้วยเบอร์โทรอย่างเดียว) จึงเก็บค่า '!' ซึ่งไม่ตรงกับ bcrypt hash ใด ๆ
function insertJudge(phone, name) {
  const sort = db.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM users WHERE role = 'judge'").get().s + 1;
  return db.prepare("INSERT INTO users (username, password_hash, name, role, sort) VALUES (?, '!', ?, 'judge', ?)")
    .run(phone, name, sort);
}

app.post('/api/judges', needLogin, needAdmin, (req, res) => {
  const name = str(req.body?.name, 200), username = normPhone(req.body?.phone ?? req.body?.username);
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อกรรมการ' });
  if (!PHONE_RE.test(username)) return res.status(400).json({ error: PHONE_ERR });
  if (usernameTaken(username)) return res.status(400).json({ error: `เบอร์ ${username} มีอยู่แล้ว` });
  const r = insertJudge(username, name);
  res.json({ judge: { id: String(r.lastInsertRowid), name, username } });
});

app.patch('/api/judges/:id', needLogin, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  const j = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'judge'").get(id);
  if (!j) return res.status(404).json({ error: 'ไม่พบกรรมการ' });
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 200) : j.name;
  const newPhone = b.phone ?? b.username;
  const username = newPhone !== undefined ? normPhone(newPhone) : j.username;
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อกรรมการ' });
  if (newPhone !== undefined && !PHONE_RE.test(username)) return res.status(400).json({ error: PHONE_ERR });
  if (usernameTaken(username, id)) return res.status(400).json({ error: `เบอร์ ${username} มีอยู่แล้ว` });
  db.prepare('UPDATE users SET name = ?, username = ? WHERE id = ?').run(name, username, id);
  // เปลี่ยนเบอร์แล้ว ให้ออกจากระบบทุกเครื่อง ต้องเข้าใหม่ด้วยเบอร์ใหม่
  if (username !== j.username) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ judge: { id: String(id), name, username } });
});

app.delete('/api/judges/:id', needLogin, needAdmin, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'judge'").run(Number(req.params.id));
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));

// ---------- Static ----------
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
});

app.listen(PORT, () => {
  console.log(`ระบบกรอกคะแนนพร้อมใช้งานที่ http://localhost:${PORT}`);
  const nets = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal);
  nets.forEach((n) => console.log(`  กรรมการในวงแลนเดียวกันเปิดได้ที่ http://${n.address}:${PORT}`));
});
