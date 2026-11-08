// Cloudflare Worker: API ระบบกรอกคะแนน + ฐานข้อมูล D1 (หน้าเว็บใน public/ ให้ Cloudflare เสิร์ฟเป็น static assets)
// API เหมือนกับ server/server.js (เวอร์ชัน Node.js สำหรับรันในวงแลน)
import { CRITERIA } from '../public/js/criteria.js';

const ITEM_MAX = Object.fromEntries(CRITERIA.flatMap((s) => s.groups.flatMap((g) => g.items)).map((i) => [i.id, i.max]));
const SESSION_DAYS = 7;
const COOKIE = 'sid';
const FAIL_WINDOW = 10 * 60 * 1000, FAIL_LIMIT = 10;
const PHONE_RE = /^0\d{8,9}$/;
const PHONE_ERR = 'เบอร์โทรศัพท์ไม่ถูกต้อง (ตัวเลข 9–10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678)';
const DEFAULT_LINES = [
  'ประเภทวิชาอุตสาหกรรมดิจิทัลและเทคโนโลยีสารสนเทศ',
  'กลุ่มอาชีพธุรกิจดิจิทัลและพาณิชอิเล็กทรอนิกส์ สาขาวิชาเทคโนโลยีธุรกิจดิจิทัล ทักษะการพัฒนานวัตกรรมเทคโนโลยีธุรกิจดิจิทัล',
  'ระดับประกาศนียบัตรวิชาชีพชั้นสูง (ปวส.) ระดับจังหวัด (อาชีวศึกษากรุงเทพมหานคร) ปีการศึกษา 2569',
];

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
function normPhone(s) {
  let d = String(s ?? '').trim().replace(/[\s\-().]/g, '');
  if (/^\+?66\d{8,9}$/.test(d)) d = `0${d.replace(/^\+?66/, '')}`;
  return d;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// รหัสผ่านผู้ดูแลระบบ: PBKDF2-SHA256 (WebCrypto) — รูปแบบ pbkdf2$รอบ$salt$hash
const PBKDF2_ITER = 100000;
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function cookieOf(req, name) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

// ---------- request context ----------
function makeCtx(req, env) {
  const db = env.DB;
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();

  async function tooManyFailures() {
    const f = await one('SELECT first, count FROM login_failures WHERE ip = ?', ip);
    if (!f) return false;
    if (Date.now() - f.first > FAIL_WINDOW) { await run('DELETE FROM login_failures WHERE ip = ?', ip); return false; }
    return f.count >= FAIL_LIMIT;
  }
  async function recordFailure() {
    const now = Date.now();
    await run(`INSERT INTO login_failures (ip, first, count) VALUES (?, ?, 1)
      ON CONFLICT (ip) DO UPDATE SET
        count = CASE WHEN ? - first > ? THEN 1 ELSE count + 1 END,
        first = CASE WHEN ? - first > ? THEN ? ELSE first END`, ip, now, now, FAIL_WINDOW, now, FAIL_WINDOW, now);
  }
  const clearFailures = () => run('DELETE FROM login_failures WHERE ip = ?', ip);

  async function judgeNo(id) {
    const ids = (await all("SELECT id FROM users WHERE role = 'judge' ORDER BY sort, id")).map((r) => r.id);
    return ids.indexOf(Number(id)) + 1;
  }
  async function publicUser(u) {
    return { id: String(u.id), username: u.username, name: u.name, role: u.role, ...(u.role === 'judge' ? { no: await judgeNo(u.id) } : {}) };
  }
  async function startSession(userId) {
    const token = randomHex(32), maxAge = SESSION_DAYS * 86400;
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, Date.now() + maxAge * 1000),
    ]);
    return sessionCookie(token, maxAge);
  }
  const usernameTaken = async (u, exceptId = 0) => !!(await one('SELECT 1 FROM users WHERE username = ? AND id <> ?', u, exceptId));

  return { db, ip, one, all, run, tooManyFailures, recordFailure, clearFailures, judgeNo, publicUser, startSession, usernameTaken };
}

// สร้างบัญชีผู้ดูแลระบบครั้งแรกจาก secret ADMIN_PASSWORD (wrangler secret put ADMIN_PASSWORD)
async function ensureAdmin(c, env) {
  if (await c.one("SELECT 1 FROM users WHERE role = 'admin'")) return;
  if (!env.ADMIN_PASSWORD) return;
  await c.run("INSERT OR IGNORE INTO users (username, password_hash, name, role) VALUES (?, ?, 'ผู้ดูแลระบบ', 'admin')",
    env.ADMIN_USERNAME || 'admin', await hashPassword(env.ADMIN_PASSWORD));
}

// ---------- routes ----------
async function handleApi(req, env, url) {
  const c = makeCtx(req, env);
  await ensureAdmin(c, env);
  const method = req.method;
  const path = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await req.json().catch(() => ({})) : {};

  const token = cookieOf(req, COOKIE);
  const user = token ? await c.one(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`, token, Date.now()) : null;
  const needLogin = () => { if (!user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ'); };
  const needAdmin = () => { needLogin(); if (user.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ'); };
  const needJudge = () => { needLogin(); if (user.role !== 'judge') throw new HttpError(403, 'เฉพาะกรรมการ'); };
  const m = (re) => path.match(re);
  let p;

  // ----- auth -----
  if (method === 'POST' && path === '/api/login') {
    if (await c.tooManyFailures()) throw new HttpError(429, 'เข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 10 นาที');
    const username = str(body.username, 64), password = String(body.password || '');
    const phone = normPhone(username);
    // กรรมการ: เบอร์โทรอย่างเดียว / ผู้ดูแลระบบ: ชื่อผู้ใช้ + รหัสผ่าน
    let u = PHONE_RE.test(phone) ? await c.one("SELECT * FROM users WHERE username = ? AND role = 'judge'", phone) : null;
    if (!u) {
      const admin = await c.one("SELECT * FROM users WHERE username = ? AND role = 'admin'", username);
      if (!admin || !(await verifyPassword(password, admin.password_hash))) {
        await c.recordFailure();
        throw new HttpError(401, PHONE_RE.test(phone) ? `ไม่พบเบอร์ ${phone} ในระบบ — ตรวจสอบเบอร์ หรือติดต่อผู้ดูแลระบบ` : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      }
      u = admin;
    }
    await c.clearFailures();
    return json({ user: await c.publicUser(u) }, 200, { 'Set-Cookie': await c.startSession(u.id) });
  }
  if (method === 'POST' && path === '/api/logout') {
    if (token) await c.run('DELETE FROM sessions WHERE token = ?', token);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (method === 'GET' && path === '/api/me') return json({ user: user ? await c.publicUser(user) : null });

  if (method === 'POST' && path === '/api/me/password') {
    needAdmin();
    const row = await c.one('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (String(body.next || '').length < 6) throw new HttpError(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    await c.db.batch([
      c.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(String(body.next)), user.id),
      c.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(user.id, token),
    ]);
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/lookup') {
    if (await c.tooManyFailures()) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาที');
    const phone = normPhone(url.searchParams.get('phone'));
    if (!PHONE_RE.test(phone)) throw new HttpError(400, PHONE_ERR);
    const j = await c.one("SELECT id, name FROM users WHERE username = ? AND role = 'judge'", phone);
    if (!j) { await c.recordFailure(); return json({ found: false, phone }); }
    return json({ found: true, phone, name: j.name, no: await c.judgeNo(j.id) });
  }

  // ----- state -----
  if (method === 'GET' && path === '/api/state') {
    needLogin();
    const isAdmin = user.role === 'admin';
    const judges = (await c.all("SELECT id, username, name FROM users WHERE role = 'judge' ORDER BY sort, id"))
      .map((j) => ({ id: String(j.id), name: j.name, ...(isAdmin ? { username: j.username } : {}) }));
    const teams = (await c.all('SELECT id, name, school FROM teams ORDER BY sort, id'))
      .map((t) => ({ id: String(t.id), name: t.name, school: t.school }));
    const where = isAdmin ? '' : ' WHERE judge_id = ?';
    const args = isAdmin ? [] : [user.id];
    const scores = {}, saved = {};
    for (const r of await c.all(`SELECT judge_id, team_id, item_id, value FROM scores${where}`, ...args)) {
      ((scores[r.judge_id] ??= {})[r.team_id] ??= {})[r.item_id] = r.value;
    }
    for (const r of await c.all(`SELECT judge_id, team_id, saved_at FROM saved${where}`, ...args)) {
      (saved[r.judge_id] ??= {})[r.team_id] = r.saved_at;
    }
    const infoRow = await c.one("SELECT value FROM settings WHERE key = 'info'");
    const info = infoRow ? JSON.parse(infoRow.value) : { title: '', lines: DEFAULT_LINES, date: '', venue: '' };
    return json({ user: await c.publicUser(user), info, judges, teams, scores, saved });
  }

  // ----- scores (กรรมการบันทึกคะแนนของตัวเอง) -----
  const teamExists = async (id) => !!(await c.one('SELECT 1 FROM teams WHERE id = ?', id));
  const isSaved = async (j, t) => !!(await c.one('SELECT 1 FROM saved WHERE judge_id = ? AND team_id = ?', j, t));

  if ((p = m(/^\/api\/scores\/(\d+)$/))) {
    needJudge();
    const teamId = Number(p[1]);
    if (method === 'PATCH') {
      if (!(await teamExists(teamId))) throw new HttpError(404, 'ไม่พบทีมนี้');
      if (await isSaved(user.id, teamId)) throw new HttpError(409, 'บันทึกแล้ว — กด "แก้ไข" ก่อนเปลี่ยนคะแนน');
      const values = body.values;
      if (!values || typeof values !== 'object') throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง');
      const clean = {};
      for (const [itemId, raw] of Object.entries(values)) {
        if (!(itemId in ITEM_MAX)) throw new HttpError(400, `ไม่มีข้อ ${itemId}`);
        if (raw === null) { clean[itemId] = null; continue; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > ITEM_MAX[itemId]) throw new HttpError(400, `คะแนนข้อ ${itemId} ต้องอยู่ระหว่าง 0–${ITEM_MAX[itemId]}`);
        clean[itemId] = Math.round(v * 100) / 100;
      }
      const stmts = Object.entries(clean).map(([i, v]) => (v === null
        ? c.db.prepare('DELETE FROM scores WHERE judge_id = ? AND team_id = ? AND item_id = ?').bind(user.id, teamId, i)
        : c.db.prepare(`INSERT INTO scores (judge_id, team_id, item_id, value) VALUES (?, ?, ?, ?)
            ON CONFLICT (judge_id, team_id, item_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
          .bind(user.id, teamId, i, v)));
      if (stmts.length) await c.db.batch(stmts);
      return json({ values: clean });
    }
    if (method === 'DELETE') {
      if (await isSaved(user.id, teamId)) throw new HttpError(409, 'บันทึกแล้ว — กด "แก้ไข" ก่อนล้างคะแนน');
      await c.run('DELETE FROM scores WHERE judge_id = ? AND team_id = ?', user.id, teamId);
      return json({ ok: true });
    }
  }

  if ((p = m(/^\/api\/saved\/(\d+)$/))) {
    needJudge();
    const teamId = Number(p[1]);
    if (method === 'POST') {
      if (!(await teamExists(teamId))) throw new HttpError(404, 'ไม่พบทีมนี้');
      const at = new Date().toISOString();
      await c.run(`INSERT INTO saved (judge_id, team_id, saved_at) VALUES (?, ?, ?)
        ON CONFLICT (judge_id, team_id) DO UPDATE SET saved_at = excluded.saved_at`, user.id, teamId, at);
      return json({ savedAt: at });
    }
    if (method === 'DELETE') {
      await c.run('DELETE FROM saved WHERE judge_id = ? AND team_id = ?', user.id, teamId);
      return json({ ok: true });
    }
  }

  // ----- admin -----
  if (method === 'PUT' && path === '/api/info') {
    needAdmin();
    const info = {
      title: str(body.title),
      lines: Array.isArray(body.lines) ? body.lines.slice(0, 10).map((l) => str(l)) : DEFAULT_LINES,
      date: str(body.date, 100),
      venue: str(body.venue),
    };
    await c.run("INSERT INTO settings (key, value) VALUES ('info', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(info));
    return json({ info });
  }

  if (method === 'POST' && path === '/api/teams') {
    needAdmin();
    const n = await c.one('SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS s FROM teams');
    const name = str(body.name, 200) || `ทีมที่ ${n.n + 1}`, school = str(body.school);
    const r = await c.run('INSERT INTO teams (name, school, sort) VALUES (?, ?, ?)', name, school, n.s + 1);
    return json({ team: { id: String(r.meta.last_row_id), name, school } });
  }
  if ((p = m(/^\/api\/teams\/(\d+)$/))) {
    needAdmin();
    const id = Number(p[1]);
    if (method === 'PATCH') {
      const t = await c.one('SELECT * FROM teams WHERE id = ?', id);
      if (!t) throw new HttpError(404, 'ไม่พบทีมนี้');
      const name = body.name !== undefined ? str(body.name, 200) : t.name;
      const school = body.school !== undefined ? str(body.school) : t.school;
      await c.run('UPDATE teams SET name = ?, school = ? WHERE id = ?', name, school, id);
      return json({ team: { id: String(id), name, school } });
    }
    if (method === 'DELETE') {
      await c.run('DELETE FROM teams WHERE id = ?', id);
      return json({ ok: true });
    }
  }

  if (method === 'POST' && path === '/api/judges') {
    needAdmin();
    const name = str(body.name, 200), phone = normPhone(body.phone ?? body.username);
    if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อกรรมการ');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, PHONE_ERR);
    if (await c.usernameTaken(phone)) throw new HttpError(400, `เบอร์ ${phone} มีอยู่แล้ว`);
    const sort = (await c.one("SELECT COALESCE(MAX(sort), 0) AS s FROM users WHERE role = 'judge'")).s + 1;
    // กรรมการไม่มีรหัสผ่าน: '!' ไม่ตรงกับรหัสผ่านใด ๆ
    const r = await c.run("INSERT INTO users (username, password_hash, name, role, sort) VALUES (?, '!', ?, 'judge', ?)", phone, name, sort);
    return json({ judge: { id: String(r.meta.last_row_id), name, username: phone } });
  }
  if ((p = m(/^\/api\/judges\/(\d+)$/))) {
    needAdmin();
    const id = Number(p[1]);
    if (method === 'PATCH') {
      const j = await c.one("SELECT * FROM users WHERE id = ? AND role = 'judge'", id);
      if (!j) throw new HttpError(404, 'ไม่พบกรรมการ');
      const name = body.name !== undefined ? str(body.name, 200) : j.name;
      const newPhone = body.phone ?? body.username;
      const phone = newPhone !== undefined ? normPhone(newPhone) : j.username;
      if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อกรรมการ');
      if (newPhone !== undefined && !PHONE_RE.test(phone)) throw new HttpError(400, PHONE_ERR);
      if (await c.usernameTaken(phone, id)) throw new HttpError(400, `เบอร์ ${phone} มีอยู่แล้ว`);
      const stmts = [c.db.prepare('UPDATE users SET name = ?, username = ? WHERE id = ?').bind(name, phone, id)];
      // เปลี่ยนเบอร์แล้ว ให้ออกจากระบบทุกเครื่อง
      if (phone !== j.username) stmts.push(c.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
      await c.db.batch(stmts);
      return json({ judge: { id: String(id), name, username: phone } });
    }
    if (method === 'DELETE') {
      await c.run("DELETE FROM users WHERE id = ? AND role = 'judge'", id);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'ไม่พบ API นี้');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' }, 500);
    }
  },
};
