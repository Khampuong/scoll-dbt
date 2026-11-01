(function () {
  'use strict';

  const STORE_KEY = 'dbt-score-app-v1';
  const app = document.getElementById('app');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const round2 = (n) => Math.round(n * 100) / 100;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : round2(n).toFixed(2).replace(/0$/, ''));

  const ITEMS = CRITERIA.flatMap((s) => s.groups.flatMap((g) => g.items));
  const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
  const TOTAL_MAX = ITEMS.reduce((a, i) => a + i.max, 0);

  // ---------- State ----------
  function defaults() {
    return {
      info: {
        title: 'การแข่งขันทักษะวิชาชีพ',
        lines: [
          'ประเภทวิชาอุตสาหกรรมดิจิทัลและเทคโนโลยีสารสนเทศ',
          'กลุ่มอาชีพธุรกิจดิจิทัลและพาณิชอิเล็กทรอนิกส์ สาขาวิชาเทคโนโลยีธุรกิจดิจิทัล ทักษะการพัฒนานวัตกรรมเทคโนโลยีธุรกิจดิจิทัล',
          'ระดับประกาศนียบัตรวิชาชีพชั้นสูง (ปวส.) ระดับจังหวัด (อาชีวศึกษากรุงเทพมหานคร) ปีการศึกษา 2569',
        ],
        date: '',
        venue: '',
      },
      judges: [1, 2, 3].map((n) => ({ id: uid(), name: `กรรมการคนที่ ${n}` })),
      teams: [1, 2, 3].map((n) => ({ id: uid(), name: `ทีมที่ ${n}`, school: '' })),
      scores: {}, // scores[judgeId][teamId][itemId] = number
      saved: {}, // saved[judgeId][teamId] = เวลาที่กดบันทึก (ล็อกไม่ให้แก้จนกว่าจะกด "แก้ไข")
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.judges) && Array.isArray(s.teams)) {
        s.scores = s.scores || {};
        s.saved = s.saved || {};
        return s;
      }
    } catch (e) { /* ignore */ }
    return defaults();
  }

  let state = load();
  const ui = { tab: 'score', judge: state.judges[0]?.id, team: state.teams[0]?.id };

  function save(msg) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { toast('บันทึกในเบราว์เซอร์ไม่สำเร็จ'); return; }
    if (msg) toast(msg);
  }

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- Score helpers ----------
  const getScore = (j, t, i) => state.scores[j]?.[t]?.[i];

  function setScore(j, t, i, v) {
    state.scores[j] = state.scores[j] || {};
    state.scores[j][t] = state.scores[j][t] || {};
    if (v === null || v === '' || Number.isNaN(v)) delete state.scores[j][t][i];
    else state.scores[j][t][i] = v;
  }

  const savedAt = (j, t) => state.saved[j]?.[t];
  function setSaved(j, t, on) {
    state.saved[j] = state.saved[j] || {};
    if (on) state.saved[j][t] = new Date().toISOString();
    else delete state.saved[j][t];
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

  const judgeTotal = (j, t) => ITEMS.reduce((a, i) => a + (Number(getScore(j, t, i.id)) || 0), 0);
  const filledCount = (j, t) => ITEMS.filter((i) => getScore(j, t, i.id) != null).length;
  const isComplete = (j, t) => filledCount(j, t) === ITEMS.length;
  const sectionTotal = (j, t, sec) => sec.groups.reduce((a, g) => a + g.items.reduce((b, i) => b + (Number(getScore(j, t, i.id)) || 0), 0), 0);

  function teamAverage(t) {
    if (!state.judges.length) return 0;
    return round2(state.judges.reduce((a, j) => a + judgeTotal(j.id, t), 0) / state.judges.length);
  }
  function sectionAverage(t, sec) {
    if (!state.judges.length) return 0;
    return round2(state.judges.reduce((a, j) => a + sectionTotal(j.id, t, sec), 0) / state.judges.length);
  }
  const unsavedPairs = (judgeId) => state.judges.filter((j) => !judgeId || j.id === judgeId)
    .flatMap((j) => state.teams.filter((t) => !savedAt(j.id, t.id)).map((t) => ({ j, t })));
  const teamComplete = (t) => state.judges.every((j) => isComplete(j.id, t));
  const medalOf = (score) => MEDALS.find((m) => score >= m.min) || MEDALS[MEDALS.length - 1];

  function ranked() {
    const rows = state.teams.map((t) => ({ team: t, avg: teamAverage(t.id) }));
    rows.sort((a, b) => b.avg - a.avg);
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.avg !== prev) { rank = i + 1; prev = r.avg; } r.rank = rank; });
    return rows;
  }

  // ---------- Render ----------
  function render() {
    if (!state.judges.some((j) => j.id === ui.judge)) ui.judge = state.judges[0]?.id;
    if (!state.teams.some((t) => t.id === ui.team)) ui.team = state.teams[0]?.id;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    document.getElementById('brandSub').textContent = state.info.title;
    document.body.classList.toggle('has-totalbar', ui.tab === 'score' && state.judges.length > 0 && state.teams.length > 0);
    if (ui.tab === 'score') renderScore();
    else if (ui.tab === 'summary') renderSummary();
    else renderSetup();
  }

  // ----- Scoring tab -----
  function chipValues(max) {
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += 0.5) out.push(v);
    return out;
  }

  function renderScore() {
    if (!state.judges.length || !state.teams.length) {
      app.innerHTML = `<div class="card"><h2>ยังไม่มีข้อมูล</h2><p class="muted">กรุณาเพิ่มกรรมการและทีมที่แท็บ "ตั้งค่า" ก่อน</p>
        <button class="btn primary" data-action="goto" data-tab="setup">ไปที่ตั้งค่า</button></div>`;
      return;
    }
    const j = ui.judge, t = ui.team;

    const judgePills = state.judges.map((jd) =>
      `<button class="pill ${jd.id === j ? 'active' : ''}" data-action="pick-judge" data-id="${jd.id}">${esc(jd.name)}</button>`).join('');

    const teamPills = state.teams.map((tm) => {
      const n = filledCount(j, tm.id);
      const cls = n === ITEMS.length ? 'done' : n > 0 ? 'partial' : '';
      return `<button class="pill ${cls} ${tm.id === t ? 'active' : ''}" data-action="pick-team" data-id="${tm.id}">
        <span class="dot"></span>${esc(tm.name)} <span class="meta" data-team-meta="${tm.id}">${fmt(judgeTotal(j, tm.id))}</span>${savedAt(j, tm.id) ? ' <span title="บันทึกแล้ว">🔒</span>' : ''}</button>`;
    }).join('');

    const sections = CRITERIA.map((sec, si) => {
      const groups = sec.groups.map((g) => {
        const multi = g.items.length > 1 || g.items[0].title;
        const items = g.items.map((it) => itemHTML(it, multi, g)).join('');
        return (multi ? `<div class="group-title">${esc(g.code)} ${esc(g.title)}</div>` : '') + items;
      }).join('');
      return `<section class="section">
        <div class="section-head"><h3>${esc(sec.no)}. ${esc(sec.title)}</h3>
          <span class="sub"><span data-sec="${si}">${fmt(sectionTotal(j, t, sec))}</span> / ${sec.max}</span></div>
        <div class="section-body">${groups}</div></section>`;
    }).join('');

    const team = state.teams.find((x) => x.id === t);
    const locked = savedAt(j, t);
    app.innerHTML = `
      <div class="card pick">
        <div><div class="muted small">ผู้ให้คะแนน</div><div class="pills">${judgePills}</div></div>
        <div><div class="muted small">ทีมที่กำลังให้คะแนน (ตัวเลข = คะแนนรวมจากกรรมการท่านนี้ · 🔒 = บันทึกแล้ว)</div><div class="pills">${teamPills}</div></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div><strong>${esc(team.name)}</strong> ${team.school ? `<span class="muted">· ${esc(team.school)}</span>` : ''}</div>
        <div class="spacer"></div>
        ${locked ? '' : `<button class="btn sm" data-action="fill-max">ให้คะแนนเต็มทุกข้อ</button>
        <button class="btn sm danger" data-action="clear-team">ล้างคะแนนทีมนี้</button>`}
      </div>
      ${locked ? `<div class="banner saved">🔒 บันทึกคะแนนแล้วเมื่อ ${esc(fmtTime(locked))} — ถ้าต้องการเปลี่ยนคะแนน กดปุ่ม <strong>แก้ไข</strong></div>`
        : '<div class="banner draft">✏️ กำลังแก้ไข — กรอกคะแนนให้ครบแล้วกด <strong>บันทึก</strong> ก่อนดาวน์โหลด</div>'}
      <div class="${locked ? 'is-locked' : ''}">${sections}</div>
      <div class="totalbar"><div class="totalbar-inner">
        <div><div class="muted small">คะแนนรวม · ${esc(team.name)}</div><div class="big"><span id="tb-total">0</span> / ${TOTAL_MAX}</div></div>
        <div class="progress" title="ความครบถ้วนของการกรอก"><span id="tb-prog"></span></div>
        <div class="small muted" id="tb-count"></div>
        ${locked ? '<button class="btn" data-action="edit-team">✏️ แก้ไข</button>' : '<button class="btn primary" data-action="save-team">💾 บันทึก</button>'}
        <button class="btn" data-action="next-team">ทีมถัดไป →</button>
      </div></div>`;
    updateTotals();
  }

  function itemHTML(it, multi, g) {
    const v = getScore(ui.judge, ui.team, it.id);
    const dis = savedAt(ui.judge, ui.team) ? 'disabled' : '';
    const code = multi ? it.id.split('.').pop() + ')' : g.code;
    const title = multi ? it.title : g.title;
    const chips = chipValues(it.max).map((c) =>
      `<button class="chip ${v === c ? 'on' : ''}" data-action="chip" data-item="${it.id}" data-v="${c}" ${dis}>${fmt(c)}</button>`).join('');
    return `<div class="item ${v == null ? 'empty' : ''}" data-item-row="${it.id}">
      <div>
        <div class="item-title"><span class="code">${esc(code)}</span>${esc(title)} <span class="muted small">(${it.max} คะแนน)</span></div>
        <ul class="item-details">${it.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
        ${it.note ? `<div class="item-note">${esc(it.note)}</div>` : ''}
      </div>
      <div class="score-ctl">
        <div class="chips">${chips}</div>
        <input class="input score-input" type="number" inputmode="decimal" min="0" max="${it.max}" step="0.5"
          data-item="${it.id}" value="${v ?? ''}" aria-label="คะแนนข้อ ${esc(it.id)}" ${dis}>
      </div>
    </div>`;
  }

  function refreshItem(id) {
    const row = app.querySelector(`[data-item-row="${CSS.escape(id)}"]`);
    if (!row) return;
    const v = getScore(ui.judge, ui.team, id);
    row.classList.toggle('empty', v == null);
    row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.v) === v));
    const inp = row.querySelector('.score-input');
    if (document.activeElement !== inp) inp.value = v ?? '';
  }

  function updateTotals() {
    const j = ui.judge, t = ui.team;
    CRITERIA.forEach((sec, si) => {
      const el = app.querySelector(`[data-sec="${si}"]`);
      if (el) el.textContent = fmt(sectionTotal(j, t, sec));
    });
    const total = judgeTotal(j, t), n = filledCount(j, t);
    const tb = document.getElementById('tb-total');
    if (tb) {
      tb.textContent = fmt(total);
      document.getElementById('tb-prog').style.width = `${(n / ITEMS.length) * 100}%`;
      document.getElementById('tb-count').textContent = `กรอกแล้ว ${n}/${ITEMS.length} ข้อ`;
    }
    const meta = app.querySelector(`[data-team-meta="${CSS.escape(t)}"]`);
    if (meta) {
      meta.textContent = fmt(total);
      const pill = meta.closest('.pill');
      pill.classList.toggle('done', n === ITEMS.length);
      pill.classList.toggle('partial', n > 0 && n < ITEMS.length);
    }
  }

  function applyScore(id, raw) {
    if (savedAt(ui.judge, ui.team)) { toast('บันทึกแล้ว — กด "แก้ไข" ก่อนเปลี่ยนคะแนน'); return; }
    const it = ITEM_BY_ID[id];
    let v = raw === '' || raw == null ? null : Number(raw);
    if (v != null) {
      if (Number.isNaN(v)) v = null;
      else v = Math.min(it.max, Math.max(0, round2(v)));
    }
    setScore(ui.judge, ui.team, id, v);
    save();
    refreshItem(id);
    updateTotals();
  }

  // ----- Summary tab -----
  function renderSummary() {
    const rows = ranked();
    const counts = Object.fromEntries(MEDALS.map((m) => [m.key, 0]));
    rows.forEach((r) => counts[medalOf(r.avg).key]++);

    const judgeHeads = state.judges.map((j) => `<th>${esc(j.name)}</th>`).join('');
    const body = rows.map((r) => {
      const m = medalOf(r.avg);
      const cells = state.judges.map((j) => {
        const done = isComplete(j.id, r.team.id);
        const saved = savedAt(j.id, r.team.id);
        return `<td class="${done ? '' : 'incomplete'}" title="${done ? '' : 'กรอกยังไม่ครบ'}">${fmt(judgeTotal(j.id, r.team.id))}${done ? '' : ' *'}
          <div class="small ${saved ? 'ok' : 'warn'}">${saved ? '🔒 บันทึกแล้ว' : 'ยังไม่บันทึก'}</div></td>`;
      }).join('');
      return `<tr><td>${r.rank}</td><td class="left">${esc(r.team.name)}</td><td class="left">${esc(r.team.school)}</td>
        ${cells}<td><strong>${fmt(r.avg)}</strong></td><td><span class="badge ${m.key}">${m.label}</span></td></tr>`;
    }).join('');

    const secHeads = CRITERIA.map((s) => `<th>ด้าน ${s.no}<br><span class="muted small">(${s.max})</span></th>`).join('');
    const secBody = rows.map((r) => `<tr><td class="left">${esc(r.team.name)}</td>${CRITERIA.map((s) => `<td>${fmt(sectionAverage(r.team.id, s))}</td>`).join('')}<td><strong>${fmt(r.avg)}</strong></td></tr>`).join('');

    const anyIncomplete = rows.some((r) => !teamComplete(r.team.id));
    const judgeBtns = state.judges.map((j) => `<button class="btn" data-action="xlsx-judge" data-id="${j.id}">📊 ใบให้คะแนน · ${esc(j.name)}</button>`).join('');
    const total = state.judges.length * state.teams.length;
    const unsavedN = unsavedPairs().length;

    app.innerHTML = `
      <div class="stats">
        ${MEDALS.map((m) => `<div class="stat"><div class="muted small">${m.label}</div><div class="n">${counts[m.key]}</div><div class="small muted">คะแนน ${m.range}</div></div>`).join('')}
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">สรุปคะแนนรวม</h2><div class="spacer"></div>
          <button class="btn primary" data-action="xlsx-summary">⬇ ดาวน์โหลด Excel สรุปคะแนน</button>
        </div>
        ${unsavedN ? `<div class="banner draft">บันทึกแล้ว ${total - unsavedN}/${total} รายการ (กรรมการ × ทีม) — กรรมการควรกด <strong>บันทึก</strong> ให้ครบก่อนดาวน์โหลด</div>`
          : total ? '<div class="banner saved">🔒 กรรมการบันทึกคะแนนครบทุกทีมแล้ว พร้อมดาวน์โหลด</div>' : ''}
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>อันดับ</th><th class="left">ทีม</th><th class="left">สถานศึกษา</th>${judgeHeads}<th>คะแนนเฉลี่ย<br><span class="muted small">(เต็ม ${TOTAL_MAX})</span></th><th>ระดับเหรียญ</th></tr></thead>
          <tbody>${body || `<tr><td colspan="${5 + state.judges.length}" class="muted">ยังไม่มีทีม</td></tr>`}</tbody>
        </table></div>
        <p class="small muted" style="margin-bottom:0">คะแนนเฉลี่ย = ผลรวมคะแนนของกรรมการทุกคน ÷ จำนวนกรรมการ (${state.judges.length} คน)
        ${anyIncomplete ? ' · <span style="color:#a06a00">* กรรมการยังกรอกคะแนนไม่ครบทุกข้อ</span>' : ''}</p>
      </div>
      <div class="card">
        <h2>คะแนนเฉลี่ยรายด้าน</h2>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th class="left">ทีม</th>${secHeads}<th>รวม</th></tr></thead>
          <tbody>${secBody}</tbody>
        </table></div>
        <p class="small muted" style="margin-bottom:0">${CRITERIA.map((s) => `ด้าน ${s.no} ${esc(s.title)}`).join(' · ')}</p>
      </div>
      <div class="card">
        <h2>ใบบันทึกคะแนนรายกรรมการ (Excel)</h2>
        <p class="muted small">รูปแบบเดียวกับชีต "กรรมการ1–3" — ทุกข้อของเกณฑ์ × ทุกทีม พร้อมชื่อกรรมการในช่องลงชื่อด้านล่าง
          (ไฟล์สรุปคะแนนด้านบนรวมชีตของกรรมการทุกคนไว้แล้ว)</p>
        <div class="row">${judgeBtns}</div>
      </div>`;
  }

  // ----- Setup tab -----
  function renderSetup() {
    const info = state.info;
    const judges = state.judges.map((j, i) => `
      <div class="list-row">
        <span class="idx">${i + 1}</span>
        <input class="input" data-bind="judge" data-id="${j.id}" value="${esc(j.name)}" placeholder="ชื่อ-สกุล กรรมการ">
        <button class="btn sm danger" data-action="del-judge" data-id="${j.id}" title="ลบ">ลบ</button>
      </div>`).join('');
    const teams = state.teams.map((t, i) => `
      <div class="list-row team">
        <span class="idx">${i + 1}</span>
        <input class="input" data-bind="team-name" data-id="${t.id}" value="${esc(t.name)}" placeholder="ชื่อทีม">
        <input class="input school" data-bind="team-school" data-id="${t.id}" value="${esc(t.school)}" placeholder="สถานศึกษา">
        <button class="btn sm danger" data-action="del-team" data-id="${t.id}" title="ลบ">ลบ</button>
      </div>`).join('');

    app.innerHTML = `
      <div class="card">
        <h2>ข้อมูลการแข่งขัน</h2>
        <div class="field"><label>ชื่อการแข่งขัน</label><input class="input" data-bind="info-title" value="${esc(info.title)}"></div>
        ${info.lines.map((l, i) => `<div class="field"><label>บรรทัดหัวกระดาษที่ ${i + 1}</label><input class="input" data-bind="info-line" data-i="${i}" value="${esc(l)}"></div>`).join('')}
        <div class="row">
          <div class="field" style="flex:1;min-width:200px"><label>วันที่แข่งขัน</label><input class="input" data-bind="info-date" value="${esc(info.date)}" placeholder="เช่น 15 ธันวาคม 2569"></div>
          <div class="field" style="flex:2;min-width:200px"><label>สถานที่</label><input class="input" data-bind="info-venue" value="${esc(info.venue)}"></div>
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0">กรรมการ (${state.judges.length} คน)</h2><div class="spacer"></div>
          <button class="btn primary sm" data-action="add-judge">+ เพิ่มกรรมการ</button></div>
        ${judges || '<p class="muted">ยังไม่มีกรรมการ</p>'}
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0">ทีมผู้เข้าแข่งขัน (${state.teams.length} ทีม)</h2><div class="spacer"></div>
          <button class="btn primary sm" data-action="add-team">+ เพิ่มทีม</button></div>
        ${teams || '<p class="muted">ยังไม่มีทีม</p>'}
      </div>
      <div class="card">
        <h2>สำรอง / รวมข้อมูล</h2>
        <p class="muted small">ข้อมูลถูกบันทึกอัตโนมัติในเบราว์เซอร์เครื่องนี้ หากกรรมการกรอกคนละเครื่อง ให้แต่ละเครื่อง "ส่งออกไฟล์ข้อมูล"
          แล้วนำมา "นำเข้าและรวมคะแนน" ที่เครื่องกลาง (ต้องเริ่มจากไฟล์ตั้งค่าเดียวกัน เพื่อให้รหัสกรรมการ/ทีมตรงกัน)</p>
        <div class="row">
          <button class="btn" data-action="export-json">⬇ ส่งออกไฟล์ข้อมูล (.json)</button>
          <button class="btn" data-action="import-json">⬆ นำเข้าและรวมคะแนน</button>
          <div class="spacer"></div>
          <button class="btn danger" data-action="reset">ล้างข้อมูลทั้งหมด</button>
        </div>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>`;
  }

  // ---------- Excel export ----------
  // ใช้ ExcelJS เพื่อให้มีเส้นตาราง การผสานเซลล์ และสูตรคำนวณในไฟล์
  // Tahoma มีในทุก Windows/Mac และรองรับภาษาไทย (TH SarabunPSK ไม่ได้ติดตั้งทุกเครื่อง)
  const XL_FONT = 'Tahoma';
  const xlFont = (o = {}) => ({ name: XL_FONT, size: 11, ...o });
  const THIN = { style: 'thin', color: { argb: 'FF000000' } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const colL = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const pageSetup = (landscape) => ({
    paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  });

  // แถวตาราง: ใส่ค่าเริ่มที่คอลัมน์ from ถึง to พร้อมเส้นขอบ
  function xlRow(ws, values, { from = 1, to, bold, fill, merge, leftCols = [1], color } = {}) {
    const r = ws.addRow([...Array(from - 1).fill(null), ...values]);
    for (let c = from; c <= to; c++) {
      const cell = r.getCell(c);
      cell.border = BORDER;
      cell.font = xlFont({ bold, ...(color ? { color: { argb: color } } : {}) });
      cell.alignment = { horizontal: leftCols.includes(c) ? 'left' : 'center', vertical: 'top', wrapText: true };
      if (fill) cell.fill = solid(fill);
    }
    if (merge) ws.mergeCells(r.number, from, r.number, to);
    return r;
  }

  // Excel ไม่ปรับความสูงแถวที่ผสานเซลล์ให้อัตโนมัติ จึงประมาณจำนวนบรรทัดเอง
  function fitHeight(ws, row, text, ncol, size = 11) {
    let width = 0;
    for (let c = 1; c <= ncol; c++) width += ws.getColumn(c).width || 9;
    const lines = Math.max(1, Math.ceil((String(text).length * (size / 11)) / (width * 1.15)));
    row.height = Math.round(lines * size * 1.6);
  }

  function xlText(ws, text, ncol, { bold, size, align = 'center' } = {}) {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, ncol);
    r.getCell(1).font = xlFont({ bold, ...(size ? { size } : {}) });
    r.getCell(1).alignment = { horizontal: align, vertical: 'middle', wrapText: true };
    fitHeight(ws, r, text, ncol, size || 11);
    return r;
  }

  function xlHeader(ws, title, ncol) {
    xlText(ws, `${title} ${state.info.title}`, ncol, { bold: true, size: 14 });
    state.info.lines.filter(Boolean).forEach((l) => xlText(ws, l, ncol));
    const when = [state.info.date && `วันที่ ${state.info.date}`, state.info.venue && `ณ ${state.info.venue}`].filter(Boolean).join(' ');
    if (when) xlText(ws, when, ncol);
    ws.addRow([]);
  }

  // ช่องลงชื่อกรรมการ (แถวละ 2 คน คนสุดท้ายที่เหลือเดี่ยวจะอยู่กึ่งกลาง)
  function xlSigns(ws, people, ncol) {
    ws.addRow([]);
    const perRow = ncol >= 4 ? 2 : 1;
    const half = Math.floor(ncol / perRow);
    for (let i = 0; i < people.length; i += perRow) {
      const chunk = people.slice(i, i + perRow);
      const spans = chunk.length === 1 ? [[1, ncol]] : chunk.map((_, k) => [k * half + 1, k === chunk.length - 1 ? ncol : (k + 1) * half]);
      ['ลงชื่อ ..................................................', (p) => `( ${p.name || '..................................................'} )`, (p) => p.role]
        .forEach((line) => {
          ws.addRow([]);
          const r = ws.lastRow;
          chunk.forEach((p, k) => {
            const [a, b] = spans[k];
            const cell = r.getCell(a);
            cell.value = typeof line === 'function' ? line(p) : line;
            cell.font = xlFont();
            cell.alignment = { horizontal: 'center' };
            if (b > a) ws.mergeCells(r.number, a, r.number, b);
          });
        });
      ws.addRow([]);
    }
  }

  const sheetName = (s) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

  function addJudgeSheet(wb, judge, idx) {
    const teams = state.teams;
    const ncol = 2 + teams.length;
    const ws = wb.addWorksheet(sheetName(`กรรมการ${idx + 1}`), { pageSetup: pageSetup(teams.length > 6) });
    ws.columns = [{ width: 75 }, { width: 11 }, ...teams.map(() => ({ width: 11 }))];
    xlHeader(ws, 'แบบบันทึกคะแนน', ncol);
    xlText(ws, `กรรมการ: ${judge.name}`, ncol, { bold: true, align: 'left' });
    const head = xlRow(ws, ['เกณฑ์การตัดสินหรือเกณฑ์การให้คะแนน', 'คะแนนเต็ม', ...teams.map((t) => t.name)], { to: ncol, bold: true, fill: 'FFE4E4E4', leftCols: [] });
    ws.views = [{ state: 'frozen', ySplit: head.number }];

    const secRows = [];
    CRITERIA.forEach((sec) => {
      xlRow(ws, [`${sec.no}. ${sec.title} (${sec.max} คะแนน)`], { to: ncol, bold: true, fill: 'FFF2F2F2', merge: true });
      const first = ws.rowCount + 1;
      sec.groups.forEach((g) => {
        const multi = g.items.length > 1 || g.items[0].title;
        if (multi) xlRow(ws, [`${g.code} ${g.title}`], { to: ncol, bold: true, merge: true });
        g.items.forEach((it) => {
          const label = multi ? `      ${it.id.split('.').pop()}) ${it.title}` : `${g.code} ${g.title}`;
          xlRow(ws, [label, it.max, ...teams.map((t) => getScore(judge.id, t.id, it.id) ?? null)], { to: ncol });
        });
      });
      const last = ws.rowCount;
      const sums = [sec.max, ...teams.map((t) => sectionTotal(judge.id, t.id, sec))];
      const r = xlRow(ws, [`รวมคะแนน ข้อ ${sec.no}`, ...sums.map((v, k) => ({ formula: `SUM(${colL(k + 2)}${first}:${colL(k + 2)}${last})`, result: v }))],
        { to: ncol, bold: true, fill: 'FFF2F2F2' });
      secRows.push(r.number);
    });
    const totals = [TOTAL_MAX, ...teams.map((t) => judgeTotal(judge.id, t.id))];
    xlRow(ws, ['รวมคะแนนทั้งหมด (100 คะแนน)', ...totals.map((v, k) => ({ formula: secRows.map((n) => `${colL(k + 2)}${n}`).join('+'), result: v }))],
      { to: ncol, bold: true, fill: 'FFE4E4E4' });

    if (teams.some((t) => t.school)) {
      ws.addRow([]);
      teams.forEach((t) => xlText(ws, `${t.name} = ${t.school || '-'}`, ncol, { align: 'left' }));
    }
    xlSigns(ws, [{ name: judge.name, role: 'กรรมการให้คะแนน' }], ncol);
  }

  function addSummarySheet(wb) {
    const J = state.judges.length;
    const ncol = 5 + J;
    const ws = wb.addWorksheet('สรุปคะแนน', { pageSetup: pageSetup(J > 4) });
    const widths = [9, 22, 32, ...state.judges.map(() => 16), 15, 22];
    while (widths.length < 8) widths.push(14); // ให้ตารางรายด้าน (8 คอลัมน์) มีความกว้างพอ
    ws.columns = widths.map((width) => ({ width }));
    xlHeader(ws, 'แบบสรุปคะแนน', ncol);

    xlRow(ws, ['อันดับ', 'ทีม', 'สถานศึกษา', ...state.judges.map((j) => j.name), `คะแนนเฉลี่ย (${TOTAL_MAX})`, 'ระดับเหรียญ'],
      { to: ncol, bold: true, fill: 'FFE4E4E4', leftCols: [] });
    const avgCol = colL(4 + J), firstJ = colL(4), lastJ = colL(3 + J);
    const medalFormula = (cell) => MEDALS.slice(0, -1).reduceRight((acc, m) => `IF(${cell}>=${m.min},"${m.label}",${acc})`, `"${MEDALS[MEDALS.length - 1].label}"`);
    let anyIncomplete = false;
    ranked().forEach((row) => {
      const n = ws.rowCount + 1;
      const judgeCells = state.judges.map((j) => judgeTotal(j.id, row.team.id));
      const r = xlRow(ws, [
        row.rank, row.team.name, row.team.school,
        ...judgeCells,
        J ? { formula: `ROUND(AVERAGE(${firstJ}${n}:${lastJ}${n}),2)`, result: row.avg } : 0,
        { formula: medalFormula(`${avgCol}${n}`), result: medalOf(row.avg).label },
      ], { to: ncol, leftCols: [2, 3] });
      r.getCell(4 + J).font = xlFont({ bold: true });
      state.judges.forEach((j, k) => {
        if (!isComplete(j.id, row.team.id)) { anyIncomplete = true; r.getCell(4 + k).font = xlFont({ color: { argb: 'FFC05A00' } }); }
      });
    });
    xlText(ws, `เกณฑ์รางวัล: ${MEDALS.map((m) => `${m.label} ${m.range} คะแนน`).join(' · ')}`, ncol, { align: 'left' });
    xlText(ws, `คะแนนเฉลี่ย = ผลรวมคะแนนจากกรรมการ ${J} คน ÷ ${J}${anyIncomplete ? ' · ตัวเลขสีส้ม = กรรมการยังกรอกคะแนนไม่ครบ' : ''}`, ncol, { align: 'left' });

    ws.addRow([]);
    xlText(ws, 'คะแนนเฉลี่ยรายด้าน', ncol, { bold: true, align: 'left' });
    const to = 2 + CRITERIA.length + 1;
    xlRow(ws, ['ทีม', ...CRITERIA.map((s) => `ด้าน ${s.no} (${s.max})`), 'รวม'], { from: 2, to, bold: true, fill: 'FFE4E4E4', leftCols: [] });
    ranked().forEach((row) => {
      const n = ws.rowCount + 1;
      xlRow(ws, [row.team.name, ...CRITERIA.map((s) => sectionAverage(row.team.id, s)),
        { formula: `SUM(${colL(3)}${n}:${colL(2 + CRITERIA.length)}${n})`, result: row.avg }], { from: 2, to, leftCols: [2] });
    });
    CRITERIA.forEach((s) => xlText(ws, `ด้าน ${s.no} ${s.title} (${s.max} คะแนน)`, ncol, { align: 'left' }));

    xlSigns(ws, state.judges.map((j, i) => ({ name: j.name, role: i === 0 ? 'ประธานกรรมการ' : 'กรรมการ' })), ncol);
  }

  async function exportExcel(kind, judgeId) {
    if (!window.ExcelJS) { toast('โหลดไลบรารี Excel ไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต'); return; }
    const pending = unsavedPairs(kind === 'judge' ? judgeId : null);
    if (pending.length) {
      const list = pending.slice(0, 8).map((p) => `• ${p.j.name} – ${p.t.name}`).join('\n') + (pending.length > 8 ? `\n… และอีก ${pending.length - 8} รายการ` : '');
      if (!confirm(`ยังมีคะแนนที่ยังไม่กด "บันทึก" ${pending.length} รายการ:\n${list}\n\nต้องการดาวน์โหลดต่อหรือไม่?`)) return;
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = 'ระบบกรอกคะแนนการแข่งขัน';
    let filename;
    if (kind === 'judge') {
      const idx = state.judges.findIndex((j) => j.id === judgeId);
      addJudgeSheet(wb, state.judges[idx], idx);
      filename = `ใบให้คะแนน-${state.judges[idx].name}.xlsx`;
    } else {
      addSummarySheet(wb);
      state.judges.forEach((j, i) => addJudgeSheet(wb, j, i));
      filename = `สรุปคะแนน-${state.info.title}.xlsx`;
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('ดาวน์โหลด Excel แล้ว');
  }

  // ---------- Import / export ----------
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `score-data-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('ไฟล์ไม่ถูกต้อง'); return; }
      if (!data || !Array.isArray(data.judges) || !Array.isArray(data.teams)) { toast('ไฟล์ไม่ถูกต้อง'); return; }
      const fresh = !Object.keys(state.scores).length;
      // เพิ่มกรรมการ/ทีมที่ยังไม่มี แล้วรวมคะแนน (คะแนนจากไฟล์ทับคะแนนเดิมของข้อเดียวกัน)
      data.judges.forEach((j) => { if (!state.judges.some((x) => x.id === j.id)) state.judges.push(j); });
      data.teams.forEach((t) => { if (!state.teams.some((x) => x.id === t.id)) state.teams.push(t); });
      if (fresh && data.info) state.info = data.info;
      Object.entries(data.saved || {}).forEach(([j, byTeam]) => Object.entries(byTeam).forEach(([t, at]) => {
        state.saved[j] = state.saved[j] || {};
        state.saved[j][t] = at;
      }));
      let n = 0;
      Object.entries(data.scores || {}).forEach(([j, byTeam]) => Object.entries(byTeam).forEach(([t, byItem]) =>
        Object.entries(byItem).forEach(([i, v]) => { if (ITEM_BY_ID[i] && typeof v === 'number') { setScore(j, t, i, v); n++; } })));
      save(`นำเข้าแล้ว ${n} คะแนน`);
      render();
    };
    reader.readAsText(file);
  }

  // ---------- Events ----------
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) { ui.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'goto': ui.tab = el.dataset.tab; render(); break;
      case 'pick-judge': ui.judge = id; render(); break;
      case 'pick-team': ui.team = id; render(); window.scrollTo(0, 0); break;
      case 'chip': applyScore(el.dataset.item, Number(el.dataset.v)); break;
      case 'next-team': {
        const i = state.teams.findIndex((t) => t.id === ui.team);
        ui.team = state.teams[(i + 1) % state.teams.length].id;
        render(); window.scrollTo(0, 0); break;
      }
      case 'fill-max':
        if (!confirm('ให้คะแนนเต็มทุกข้อสำหรับทีมนี้? (ปรับลดทีละข้อได้ภายหลัง)')) return;
        ITEMS.forEach((it) => setScore(ui.judge, ui.team, it.id, it.max));
        save('ให้คะแนนเต็มแล้ว'); render(); break;
      case 'clear-team':
        if (!confirm('ล้างคะแนนของทีมนี้ (เฉพาะกรรมการท่านที่เลือก)?')) return;
        if (state.scores[ui.judge]) delete state.scores[ui.judge][ui.team];
        save('ล้างคะแนนแล้ว'); render(); break;
      case 'add-judge':
        state.judges.push({ id: uid(), name: `กรรมการคนที่ ${state.judges.length + 1}` });
        save(); render(); break;
      case 'del-judge': {
        const j = state.judges.find((x) => x.id === id);
        if (!confirm(`ลบ "${j.name}" และคะแนนที่กรรมการท่านนี้ให้ไว้ทั้งหมด?`)) return;
        state.judges = state.judges.filter((x) => x.id !== id);
        delete state.scores[id];
        delete state.saved[id];
        save('ลบกรรมการแล้ว'); render(); break;
      }
      case 'add-team':
        state.teams.push({ id: uid(), name: `ทีมที่ ${state.teams.length + 1}`, school: '' });
        save(); render(); break;
      case 'del-team': {
        const t = state.teams.find((x) => x.id === id);
        if (!confirm(`ลบ "${t.name}" และคะแนนของทีมนี้ทั้งหมด?`)) return;
        state.teams = state.teams.filter((x) => x.id !== id);
        Object.values(state.scores).forEach((byTeam) => delete byTeam[id]);
        Object.values(state.saved).forEach((byTeam) => delete byTeam[id]);
        save('ลบทีมแล้ว'); render(); break;
      }
      case 'xlsx-summary': exportExcel('summary'); break;
      case 'xlsx-judge': exportExcel('judge', id); break;
      case 'save-team': {
        const missing = ITEMS.length - filledCount(ui.judge, ui.team);
        if (missing && !confirm(`ยังไม่ได้กรอกคะแนน ${missing} ข้อ (จะนับเป็น 0) ต้องการบันทึกหรือไม่?`)) return;
        setSaved(ui.judge, ui.team, true);
        save('บันทึกคะแนนแล้ว 🔒'); render(); break;
      }
      case 'edit-team':
        setSaved(ui.judge, ui.team, false);
        save('ปลดล็อกแล้ว แก้ไขคะแนนได้ — อย่าลืมกดบันทึกอีกครั้ง'); render(); break;
      case 'export-json': exportJSON(); break;
      case 'import-json': document.getElementById('importFile').click(); break;
      case 'reset':
        if (!confirm('ล้างข้อมูลทั้งหมด (กรรมการ ทีม และคะแนน)? แนะนำให้ส่งออกไฟล์สำรองก่อน')) return;
        state = defaults(); ui.judge = state.judges[0].id; ui.team = state.teams[0].id;
        save('ล้างข้อมูลแล้ว'); render(); break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'importFile' && el.files[0]) { importJSON(el.files[0]); el.value = ''; return; }
    if (el.classList.contains('score-input')) { applyScore(el.dataset.item, el.value); el.value = getScore(ui.judge, ui.team, el.dataset.item) ?? ''; }
  });

  // ช่องข้อความในหน้าตั้งค่า: บันทึกทันทีขณะพิมพ์ ไม่ render ใหม่เพื่อไม่ให้เคอร์เซอร์หลุด
  document.addEventListener('input', (e) => {
    const el = e.target, b = el.dataset.bind;
    if (!b) return;
    const v = el.value;
    if (b === 'judge') state.judges.find((x) => x.id === el.dataset.id).name = v;
    else if (b === 'team-name') state.teams.find((x) => x.id === el.dataset.id).name = v;
    else if (b === 'team-school') state.teams.find((x) => x.id === el.dataset.id).school = v;
    else if (b === 'info-title') { state.info.title = v; document.getElementById('brandSub').textContent = v; }
    else if (b === 'info-line') state.info.lines[Number(el.dataset.i)] = v;
    else if (b === 'info-date') state.info.date = v;
    else if (b === 'info-venue') state.info.venue = v;
    save();
  });

  render();
})();
