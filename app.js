/* ══════════════════════════════════════════════════════════════════
   app.js — הרכבה. מחבר בין האחסון, המנוע והמשחקים.

   שלב 1: בלי Firebase בכלל. כל התשובות נשמרות ב-outbox המקומי,
   שהוא בדיוק אותו מבנה שיידחף ל-Firestore בשלב 2.
   ══════════════════════════════════════════════════════════════════ */

import * as db from './db.js';
import * as E from './engine.js';
import * as cloud from './cloud.js';
import * as sync from './sync.js';
import * as kit from './kit.js';
import * as vocab from './vocab.js';
import * as speech from './speech.js';
import { drill, wordle, listen } from './games.js';

const PACKS = [
  'data/packs/grammar-core-v1.json',
  'data/packs/lexis-british-v1.json',
  'data/packs/listening-rp-v1.json',
  'data/packs/reading-games-v1.json',
  'data/packs/speaking-rp-v1.json'
];

const DRILL_TYPES = ['mcq', 'cloze', 'error_spot', 'order', 'translate'];
const SPEAK_TYPES = ['pronounce', 'shadow'];
const SESSION_LEN = 12;
const START_RATING = 1450;
const TAXONOMY_VERSION = 2;      // העלה כשמוסיפים צומת לעץ הנושאים          // מתאים לרמת B2-C1 שהצהרת עליה

const view = document.getElementById('view');
const bar  = { title: document.getElementById('barTitle'),
               back:  document.getElementById('back'),
               net:   document.getElementById('net'),
               line:  document.getElementById('line') };

let taxonomy = null;
let session  = null;

/* ══════════════════════════════════════════════════════════════════
   הפעלה
   ══════════════════════════════════════════════════════════════════ */
boot();

async function boot() {
  showNet();
  addEventListener('online',  showNet);
  addEventListener('offline', showNet);
  bar.back.addEventListener('click', () => home());

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); }
    catch (e) { console.warn('SW לא נרשם:', e); }
  }

  await db.open();
  await seed();
  await home();

  // Firebase עולה *אחרי* שהאפליקציה כבר עובדת, ובלי await חוסם.
  // אם הוא לא נטען — לא קרה כלום, ממשיכים מקומית.
  cloud.init().then(ok => {
    if (!ok) return;
    sync.autoSync();
    cloud.onAuth(() => { if (!session) home(); });
    sync.onStatus(paintSyncStatus);
  });
}

let lastSync = null;
function paintSyncStatus(s) {
  lastSync = s;
  const host = document.getElementById('syncLine');
  if (!host) return;
  const map = {
    running: ['מסנכרן…', ''],
    ok:      [`מסונכרן · ${s.pending || 0} ממתינות`, s.pending ? '' : 'ok'],
    error:   ['הסנכרון נכשל — ננסה שוב', 'warn']
  };
  const [text, tone] = map[s.state] || ['', ''];
  host.textContent = text;
  if (tone) host.dataset.tone = tone; else delete host.dataset.tone;
}

function showNet() {
  const off = !navigator.onLine;
  bar.net.textContent = off ? 'OFFLINE' : 'ONLINE';
  bar.net.dataset.off = off ? '1' : '0';
}

/* ── טעינת התוכן פעם אחת ────────────────────────────────────────── */
async function seed() {
  taxonomy = await db.getMeta('taxonomy');
  const have = await db.count('items');

  // עץ הנושאים נשמר מקומית, ולכן צומת חדש לא מגיע למכשירים שכבר
  // התקינו — אלא אם בודקים גרסה. בלי הבדיקה הזאת "אוצר המילים שלי"
  // היה מופיע כמזהה גולמי במקום כשם בעברית.
  if (taxonomy && have > 0) {
    if ((taxonomy.version || 1) >= TAXONOMY_VERSION) return;
    try {
      const fresh = await (await fetch('data/taxonomy.json', { cache: 'no-cache' })).json();
      await db.setMeta('taxonomy', fresh);
      taxonomy = fresh;
    } catch { /* אין רשת — נמשיך עם מה שיש */ }
    return;
  }

  view.innerHTML = `<section class="pad"><p class="eyebrow">LOADING</p>
    <h1 class="display">טוען את בנק השאלות</h1>
    <p style="color:var(--slate)">פעם אחת בלבד. מכאן והלאה הכול עובד גם בלי רשת.</p></section>`;

  const tax = await (await fetch('data/taxonomy.json')).json();
  await db.setMeta('taxonomy', tax);
  taxonomy = tax;

  for (const url of PACKS) {
    const pack = await (await fetch(url)).json();
    const rows = pack.items.map(it => ({
      ...it,
      packId: pack.packId,
      top: it.skill.split('.')[0]
    }));
    await db.putMany('items', rows);
    await db.put('packs', { packId: pack.packId, version: pack.version, count: rows.length });
  }
}

/* ══════════════════════════════════════════════════════════════════
   מסך הבית
   ══════════════════════════════════════════════════════════════════ */
async function home() {
  session = null;
  bar.back.hidden = true;
  bar.line.hidden = true;
  bar.title.textContent = 'אנגלית בריטית';
  mount('tpl-home');

  const [aggRows, outbox, pool] = await Promise.all([
    db.all('agg'),
    db.all('outbox'),
    db.candidates({ types: DRILL_TYPES })
  ]);

  const drillPool = pool.filter(i => i.top !== 'listening');
  const wordlePool = (await db.candidates({ types: ['wordle'] })).length;

  document.getElementById('statAvail').textContent = drillPool.length + wordlePool;
  document.getElementById('statDone').textContent  = outbox.length;

  const root = aggRows.find(r => !r.skillId.includes('.') && r.skillId === 'grammar');
  const recent = aggRows.flatMap(r => r.skillId.includes('.') ? [] : (r.recent || []));
  document.getElementById('statAcc').textContent =
    recent.length ? Math.round(100 * recent.reduce((a, b) => a + b, 0) / recent.length) + '%' : '—';

  renderWeak(aggRows);
  renderAccount();

  document.querySelectorAll('[data-game]').forEach(b =>
    b.addEventListener('click', () => start(b.dataset.game)));
  document.querySelector('[data-nav="flight"]')?.addEventListener('click', flight);
  document.querySelector('[data-nav="vocab"]')?.addEventListener('click', vocabScreen);
  speech.capabilities().then(cap => {
    const note = document.getElementById('speakNote');
    if (!note) return;
    if (!cap.recorder && !cap.recognition) note.textContent = 'לא נתמך במכשיר הזה';
    else if (!cap.recognition || !navigator.onLine) note.textContent = 'חיקוי בלבד — ניקוד דורש רשת';
  });

  vocab.count().then(n => {
    const note = document.getElementById('vocabNote');
    if (note && n) note.textContent = `${n} מילים · ${n * 3} שאלות בתרגול`;
  });

  const ks = await kit.kitStatus();
  if (ks.exists) {
    document.getElementById('flightLabel').textContent =
      ks.left ? `ערכת טיסה · ${ks.left} שאלות מוכנות` : 'ערכת הטיסה נוצלה';
    document.getElementById('flightNote').textContent =
      ks.left ? `${ks.pct}% נוצלו · ${E.fmtBytes(ks.kit.bytes)} אודיו` : 'בנה ערכה חדשה';
  }
  document.getElementById('toStats').addEventListener('click', stats);
  const pending = outbox.filter(r => r.status !== 'synced').length;
  document.getElementById('footNote').textContent =
    `${outbox.length} תשובות שמורות במכשיר · ${pending} ממתינות לסנכרון`;
}

/* ══════════════════════════════════════════════════════════════════
   חשבון וסנכרון
   ══════════════════════════════════════════════════════════════════ */
async function renderAccount() {
  const host = document.getElementById('acct');
  if (!host) return;

  if (!cloud.configured()) {
    host.innerHTML = `<div class="acct__row">
      <span class="acct__k">Firebase לא מוגדר</span>
      <span class="acct__v">מלא את js/config.js</span></div>
      <div class="acct__row"><span class="acct__k">האפליקציה עובדת מקומית במלואה</span></div>`;
    return;
  }
  if (!cloud.available()) {
    host.innerHTML = `<div class="acct__row">
      <span class="acct__k">אין חיבור לענן כרגע</span>
      <span class="acct__v">מקומי בלבד</span></div>`;
    return;
  }

  const u = cloud.user();
  const pending = await db.pendingCount();
  const lastAt = await db.getMeta('lastSyncAt', 0);
  const when = lastAt
    ? new Date(lastAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'עדיין לא';

  if (!u) {
    host.innerHTML = `
      <div class="acct__row">
        <span class="acct__k">לא מחובר</span>
        <span class="acct__v">${pending} תשובות ממתינות</span>
      </div>
      <div class="acct__row">
        <span class="acct__k">התחברות מפעילה סנכרון בין מכשירים.
        כל מה שתרגלת עד עכשיו יעלה בפעם הראשונה.</span>
      </div>
      <button class="acct__btn" id="signIn">התחברות עם Google</button>`;
    document.getElementById('signIn').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'מתחבר…';
      try { await cloud.signIn(); }
      catch (err) { alert('ההתחברות נכשלה: ' + (err.code || err.message)); renderAccount(); }
    });
    return;
  }

  host.innerHTML = `
    <div class="acct__row">
      <span class="acct__k">מחובר</span>
      <span class="acct__v">${u.email || u.uid.slice(0, 12)}</span>
    </div>
    <div class="acct__row">
      <span class="acct__k">סנכרון אחרון</span>
      <span class="acct__v">${when}</span>
    </div>
    <div class="acct__row">
      <span class="acct__k">ממתינות לסנכרון</span>
      <span class="acct__v" id="syncLine" ${pending ? '' : 'data-tone="ok"'}>${pending}</span>
    </div>
    <button class="acct__btn" id="syncNow">סנכרן עכשיו</button>
    <button class="acct__btn acct__btn--out" id="signOut">התנתקות</button>`;

  if (lastSync) paintSyncStatus(lastSync);

  document.getElementById('syncNow').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'מסנכרן…';
    const r = await sync.run({ force: true });
    e.target.disabled = false; e.target.textContent = 'סנכרן עכשיו';
    if (r.skipped) alert('לא סונכרן: ' + r.skipped);
    else if (r.error) alert('הסנכרון נכשל: ' + r.error);
    renderAccount();
  });

  document.getElementById('signOut').addEventListener('click', async () => {
    const left = await db.pendingCount();
    if (left && !confirm(`יש ${left} תשובות שטרם סונכרנו. הן יישארו במכשיר. להתנתק בכל זאת?`)) return;
    await cloud.signOut();
    renderAccount();
  });
}

function renderWeak(aggRows) {
  const host = document.getElementById('weakList');
  const leaves = aggRows.filter(r => r.skillId.split('.').length >= 2 && r.total >= 3);

  if (!leaves.length) {
    host.innerHTML = `<div class="weak__empty">עוד אין מספיק נתונים.
      אחרי סבב או שניים תראה כאן בדיוק היכן אתה נופל.</div>`;
    return;
  }

  const named = (id) => (taxonomy?.nodes || []).find(n => n.id === id)?.titleHe || id;
  const scored = leaves
    .map(r => ({ ...r, w: E.weakness(r), acc: r.correct / r.total }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);

  host.innerHTML = scored.map(r => `
    <div class="weak__row">
      <div class="weak__top">
        <span class="weak__name">${named(r.skillId)}</span>
        <span class="weak__pct">${Math.round(r.acc * 100)}% · ${r.total}</span>
      </div>
      <div class="weak__bar"><span style="width:${Math.round(r.acc * 100)}%"
        ${r.acc >= 0.75 ? 'data-ok="1"' : ''}></span></div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════════
   סבב תרגול
   ══════════════════════════════════════════════════════════════════ */
async function start(game) {
  const types = game === 'wordle' ? ['wordle']
              : game === 'speak'  ? SPEAK_TYPES
              : DRILL_TYPES;
  let pool = await db.candidates({ types });
  if (game === 'drill') pool = pool.filter(i => i.top !== 'listening');

  /* מצב דיבור: מסננים לפי מה שהמכשיר באמת יכול לעשות עכשיו.
     בלי הסינון הזה תקבל בטיסה פריט הגייה שדורש רשת, ואין דבר
     מתסכל יותר מכפתור שלא יכול לעבוד.                          */
  if (game === 'speak') {
    const cap = await speech.capabilities();
    const online = navigator.onLine;
    if (!cap.recognition || !online) {
      pool = pool.filter(i => i.type === 'shadow');
    }
    if (!cap.recorder) {
      pool = pool.filter(i => i.type !== 'shadow');
    }
    if (!pool.length) {
      alert(!cap.recorder && !cap.recognition
        ? 'המכשיר הזה לא תומך במיקרופון או בזיהוי דיבור.'
        : 'נגמרו פריטי הדיבור הזמינים במצב הנוכחי.');
      return;
    }
    if (!(await speech.checkMic())) {
      alert('צריך הרשאת מיקרופון כדי לתרגל דיבור.');
      return;
    }
  }

  if (!pool.length) {
    alert('נגמרו השאלות החדשות במשחק הזה. אפס את ההתקדמות או המתן לחבילת תוכן נוספת.');
    return;
  }

  const aggRows = await db.all('agg');
  const agg = Object.fromEntries(aggRows.map(r => [r.skillId, r]));
  const rating = await db.getMeta('rating', START_RATING);

  session = {
    game, pool, agg, rating,
    n: Math.min(SESSION_LEN, pool.length),
    i: 0, marks: [], wrong: []
  };

  bar.back.hidden = false;
  bar.line.hidden = false;
  bar.title.textContent = game === 'wordle' ? 'ניחוש מילה'
                        : game === 'speak'  ? 'הגייה וחיקוי'
                        : 'אימון מעורב';
  drawLine();
  await nextQuestion();
}

function drawLine() {
  bar.line.innerHTML = Array.from({ length: session.n }, (_, i) => {
    const s = session.marks[i] !== undefined
      ? (session.marks[i] ? 'ok' : 'no')
      : (i === session.i ? 'now' : '');
    return `<i${s ? ` data-s="${s}"` : ''}></i>`;
  }).join('');
}

async function nextQuestion() {
  if (session.i >= session.n) return finish();

  let item;
  if (session.fromKit) {
    // הבחירה כבר נעשתה בזמן בניית הערכה, כשעוד הייתה רשת.
    // בטיסה רק שולפים לפי הסדר — אפס חישוב, אפס הפתעות.
    item = await kit.nextFromKit();
  } else if (session.game === 'wordle') {
    item = session.pool[Math.floor(Math.random() * session.pool.length)];
  } else {
    item = E.pickNext({ candidates: session.pool, agg: session.agg,
                        userRating: session.rating, recent: session.marks });
  }

  if (!item) return finish();

  session.pool = session.pool.filter(x => x.id !== item.id);
  session.item = item;

  // מסמנים כ"הוצג" מיד, לא אחרי התשובה.
  // אם האפליקציה תיפול באמצע השאלה — לא תפגוש אותה שוב.
  await db.put('served', { itemId: item.id, servedAt: Date.now(), packId: item.packId });

  mount('tpl-play');
  drawLine();

  const named = (id) => (taxonomy?.nodes || []).find(n => n.id === id)?.titleEn || id;
  document.getElementById('qMeta').textContent =
    `${session.i + 1} / ${session.n} · ${named(item.skill).toUpperCase()} · ${item.cefr}`;

  const body = document.getElementById('qBody');
  let api;

  if (item.type === 'wordle') {
    api = wordle(item, body);
  } else if (item.type === 'minimal_pair' || item.type === 'dictation') {
    const url = await kit.audioUrlFor(item.id);
    if (!url) {           // אין אודיו — מדלגים במקום להציג שאלה שאי אפשר לענות עליה
      if (session.fromKit) await kit.markConsumed(item.id);
      session.i++;
      return nextQuestion();
    }
    api = listen(item, body, url);
  } else {
    api = drill(item, body);
  }

  api.onAnswer = (response) => grade(item, response, api);
}

async function grade(item, response, api) {
  /* פריטי דיבור לא עוברים דרך checkAnswer: אין תשובה אחת נכונה אלא
     ציון רציף, ובחיקוי אין ציון בכלל. הם מטופלים בנפרד ואז מצטרפים
     לאותו מסלול רישום — כך היומן נשאר אחיד וגם הסנכרון.          */
  let correct, expected = '', speechMeta = null;

  if (item.type === 'pronounce') {
    if (response?.skipped) { session.i++; return nextQuestion(); }

    const result = E.scorePronunciation({
      target: item.target,
      heard: response.transcript,
      confidence: response.confidence,
      isolated: true                    // מילה בודדת — הניקוד אמין
    });
    result.heardText = response.transcript;

    correct = result.score >= 80;
    expected = item.target;
    speechMeta = {
      score: result.score,
      heard: response.transcript,
      confidence: Math.round((result.confidence ?? 0) * 100) / 100,
      patterns: result.patterns.map(p => p.tag)
    };
    api.lock({ correct, result });

  } else if (item.type === 'shadow') {
    /* חיקוי תמיד נחשב "נכון": המטרה היא חשיפה ותרגול, לא מבחן.
       ניקוד מזויף כאן היה מרעיל את מדידת החולשות בכל המערכת.    */
    correct = true;
    expected = item.sentence;
    speechMeta = { shadowed: true, ratio: response?.ratio ?? null };
    api.lock({ correct });

  } else {
    ({ correct, expected } = E.checkAnswer(item, response));
    const chosen = typeof response === 'number' ? response : null;
    api.lock({ correct, chosen });
  }

  // ── עדכון דירוגים ──
  const answered = (await db.all('outbox')).length;
  const r = E.updateRatings(session.rating, item.difficulty, correct, answered);
  session.rating = r.user;
  await db.setMeta('rating', session.rating);

  // ── רישום אטומי: תשובה + סטטיסטיקה + סימון הצגה ──
  const aggRows = E.applyAttempt(session.agg, item, correct);
  aggRows.forEach(row => session.agg[row.skillId] = row);

  await db.recordAttempt({
    attempt: {
      attemptId: E.newAttemptId(),
      itemId: item.id, itemType: item.type, skillId: item.skill, packId: item.packId,
      correct,
      response: speechMeta ? JSON.stringify(speechMeta).slice(0, 200) : String(response),
      expected,
      speech: speechMeta || undefined,
      clientCreatedAt: Date.now(),
      wasOffline: !navigator.onLine,
      status: 'pending',                 // בשלב 2 זה מה שיידחף ל-Firestore
      appVersion: 1
    },
    aggRows,
    servedRow: { itemId: item.id, servedAt: Date.now(), packId: item.packId }
  });

  // ── לוח החזרות ──
  // נכון בפעם הראשונה → פורש. טעות → חוזר מחר, ומתרחק בכל הצלחה.
  const prevSched = await db.get('schedule', item.id);
  const nextSched = item.type === 'shadow'
    ? prevSched || null                 // חיקוי לא מזיז את הלוח
    : E.scheduleAfter(prevSched, correct);
  if (nextSched) await db.put('schedule', { itemId: item.id, ...nextSched });
  else if (prevSched) await db.del('schedule', item.id);

  if (session.fromKit) await kit.markConsumed(item.id);

  session.marks.push(correct);
  if (!correct) session.wrong.push(item);
  drawLine();
  showVerdict(item, correct, expected);
}

function showVerdict(item, correct, expected) {
  const v = document.getElementById('verdict');
  const head = document.getElementById('verdictHead');
  const fix = document.getElementById('verdictFix');
  const why = document.getElementById('verdictWhy');

  head.textContent = correct ? 'נכון' : 'לא נכון';
  head.dataset.ok = correct ? '1' : '0';

  if (item.type === 'error_spot') {
    fix.hidden = false;
    fix.textContent = E.correctedSentence(item);
  } else if (!correct && expected) {
    fix.hidden = false;
    fix.textContent = expected;
  } else {
    fix.hidden = true;
  }

  why.textContent = item.explanationHe;
  v.hidden = false;
  v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('next').addEventListener('click', () => {
    session.i++;
    nextQuestion();
  }, { once: true });
}

/* ══════════════════════════════════════════════════════════════════
   סיכום
   ══════════════════════════════════════════════════════════════════ */
function finish() {
  const ok = session.marks.filter(Boolean).length;
  mount('tpl-done');
  bar.line.hidden = true;

  document.getElementById('doneScore').textContent = `${ok} מתוך ${session.marks.length}`;

  const list = document.getElementById('doneList');
  if (!session.wrong.length) {
    list.innerHTML = `<div class="plate__row"><span class="plate__k">סבב מושלם. אין מה לחזור עליו.</span></div>`;
  } else {
    list.innerHTML = session.wrong.map(it => `
      <div class="plate__row" style="flex-direction:column; align-items:stretch; gap:6px">
        <span class="plate__k" dir="ltr" style="font-family:var(--en); font-weight:600">
          ${(it.stem || it.sentence || it.he || it.target || '').slice(0, 70)}</span>
        <span style="font-size:13px; color:var(--ink-2)">${it.explanationHe}</span>
      </div>`).join('');
  }

  sync.run();   // סוף סבב הוא רגע טוב לדחוף — המשתמש לא ממתין לכלום

  const g = session.game;
  const fromKit = session.fromKit;
  document.getElementById('again').addEventListener('click',
    () => fromKit ? startFlight() : start(g));
  document.getElementById('doneHome').addEventListener('click', home);
}

/* ══════════════════════════════════════════════════════════════════
   מצב טיסה
   ══════════════════════════════════════════════════════════════════ */
async function flight() {
  session = null;
  bar.back.hidden = false;
  bar.line.hidden = true;
  bar.title.textContent = 'מצב טיסה';
  mount('tpl-flight');
  await paintGauge();
  await paintKitPanel();
}

async function paintGauge() {
  const s = await kit.storageReport();
  const cap = kit.CAP_BYTES;

  // הסקאלה היא התקציב שלנו או המקום הפנוי — הקטן מביניהם קובע
  const scale = Math.max(cap, s.audioBytes, 1);
  const pct = Math.min(100, 100 * s.audioBytes / scale);

  const fill = document.getElementById('gaugeFill');
  fill.style.width = pct + '%';
  if (pct > 90) fill.dataset.full = '1';

  document.getElementById('gaugeCap').style.insetInlineStart =
    Math.min(100, 100 * cap / scale) + '%';
  document.getElementById('gaugeUsed').textContent = E.fmtBytes(s.audioBytes);
  document.getElementById('gaugeCapTxt').textContent = E.fmtBytes(cap);
  document.getElementById('gaugeFree').textContent = s.quota ? E.fmtBytes(s.free) : 'לא ידוע';

  const note = document.getElementById('gaugeNote');
  if (!s.quota) {
    note.textContent = 'הדפדפן לא מדווח על מכסת אחסון. נוריד עד התקציב ונעצור.';
  } else if (s.free < cap) {
    note.dataset.tone = 'warn';
    note.textContent = `במכשיר פנויים ${E.fmtBytes(s.free)} בלבד — פחות מהתקציב. הערכה תוקטן בהתאם.`;
  } else if (!s.persisted) {
    note.textContent = 'אחסון קבוע לא אושר. אנדרואיד עלול לפנות את האודיו כשהמקום נגמר — כלומר בדיוק לפני הטיסה.';
  } else {
    note.textContent = 'אחסון קבוע אושר. מה שהורדת יישאר.';
  }
}

async function paintKitPanel() {
  const host = document.getElementById('kitPanel');
  const ks = await kit.kitStatus();
  const mf = await kit.loadManifest();
  const audioCount = Object.keys(mf.byItem || {}).length;

  if (ks.exists) {
    const b = ks.kit.breakdown;
    const total = Object.values(b).reduce((a, c) => a + c, 0) || 1;
    const seg = (k, label, n) => n
      ? `<i data-k="${k}" style="width:${100 * n / total}%" title="${label} ${n}"></i>` : '';

    host.innerHTML = `
      <h2 class="sect">הערכה הנוכחית</h2>
      <div class="mixbar">
        ${seg('weak', 'חולשות', b.weak)}${seg('review', 'חזרה', b.review)}
        ${seg('retain', 'שימור', b.retain)}${seg('discover', 'גילוי', b.discover)}
        ${seg('filler', 'השלמה', b.filler)}
      </div>
      <div class="mixkey">
        <span><em style="background:var(--signal)"></em>חולשות ${b.weak}</span>
        <span><em style="background:var(--brass)"></em>חזרה ${b.review}</span>
        <span><em style="background:var(--go)"></em>שימור ${b.retain}</span>
        <span><em style="background:var(--ink)"></em>גילוי ${b.discover}</span>
        ${b.filler ? `<span><em style="background:var(--slate)"></em>השלמה ${b.filler}</span>` : ''}
      </div>

      <div class="plate">
        <div class="plate__row"><span class="plate__k">נותרו בערכה</span>
          <span class="plate__v num">${ks.left} / ${ks.total}</span></div>
        <div class="plate__row"><span class="plate__k">נושאים מכוסים</span>
          <span class="plate__v num">${ks.kit.skillsCovered}</span></div>
        <div class="plate__row"><span class="plate__k">אודיו שהורד</span>
          <span class="plate__v num">${E.fmtBytes(ks.kit.bytes)}</span></div>
        ${ks.kit.droppedForSpace ? `<div class="plate__row">
          <span class="plate__k">הושמטו מחוסר אודיו</span>
          <span class="plate__v num">${ks.kit.droppedForSpace}</span></div>` : ''}
      </div>

      ${ks.left ? `<button class="cta" id="flyNow">תרגול מהערכה</button>` : ''}
      <button class="ghost" id="rebuild">בנייה מחדש</button>
      <button class="danger" id="dropKit">מחיקת הערכה והאודיו</button>`;

    document.getElementById('flyNow')?.addEventListener('click', startFlight);
    document.getElementById('rebuild').addEventListener('click', () => runBuild(true));
    document.getElementById('dropKit').addEventListener('click', async () => {
      if (!confirm('למחוק את הערכה ואת כל האודיו שהורד?')) return;
      await kit.discardKit({ keepAudio: false });
      flight();
    });
    return;
  }

  host.innerHTML = `
    <h2 class="sect">בניית ערכה</h2>
    <p class="ask">
      הערכה נבנית מהחולשות שהמנוע זיהה, מפריטים שנפלת בהם ושהגיע מועד החזרה שלהם,
      ומעט נושאים חדשים כדי שלא יהיה משעמם. כל פריט מופיע פעם אחת בלבד.
    </p>
    ${audioCount ? '' : `<p class="ask" data-tone="warn" style="color:var(--signal)">
      אין קובצי אודיו זמינים. הרץ <code dir="ltr">node tools/build-audio.mjs</code> ופרוס מחדש,
      אחרת פריטי ההאזנה לא ייכנסו לערכה.</p>`}
    <button class="cta" id="build">בנה ערכה</button>
    <button class="ghost" id="buildText">בנה בלי אודיו (טקסט בלבד)</button>`;

  document.getElementById('build').addEventListener('click', () => runBuild(false, true));
  document.getElementById('buildText').addEventListener('click', () => runBuild(false, false));
}

let buildAbort = null;

async function runBuild(rebuild, withAudio = true) {
  if (rebuild && !confirm('לבנות ערכה חדשה? הערכה הנוכחית תוחלף.')) return;

  const host = document.getElementById('kitPanel');
  host.innerHTML = `
    <div class="prog">
      <div id="progText">מתחיל…</div>
      <div class="prog__bar"><span id="progFill"></span></div>
    </div>
    <button class="ghost" id="cancelBuild">ביטול</button>`;

  buildAbort = new AbortController();
  document.getElementById('cancelBuild').addEventListener('click', () => buildAbort.abort());

  const res = await kit.buildKit({
    withAudio,
    signal: buildAbort.signal,
    onProgress: ({ text, done, total }) => {
      const t = document.getElementById('progText');
      const f = document.getElementById('progFill');
      if (!t) return;
      t.textContent = total ? `${text} · ${done} מתוך ${total}` : text;
      if (f && total) f.style.width = Math.round(100 * done / total) + '%';
    }
  });

  if (!res.ok) { alert(res.reason); return flight(); }
  await paintGauge();
  await paintKitPanel();
}

/* ── סבב מהערכה ───────────────────────────────────────────────────
   זהה לסבב רגיל, אלא שהשאלות נשלפות מהערכה לפי סדר במקום מהמנוע.
   הבחירה כבר נעשתה בזמן הבנייה, כשעוד הייתה רשת.                */
async function startFlight() {
  const ks = await kit.kitStatus();
  if (!ks.exists || !ks.left) return;

  const aggRows = await db.all('agg');
  session = {
    game: 'flight',
    fromKit: true,
    agg: Object.fromEntries(aggRows.map(r => [r.skillId, r])),
    rating: await db.getMeta('rating', START_RATING),
    n: Math.min(SESSION_LEN, ks.left),
    i: 0, marks: [], wrong: [], pool: []
  };

  bar.back.hidden = false;
  bar.line.hidden = false;
  bar.title.textContent = 'מצב טיסה';
  drawLine();
  await nextQuestion();
}

/* ══════════════════════════════════════════════════════════════════
   נתונים
   ══════════════════════════════════════════════════════════════════ */
async function stats() {
  bar.back.hidden = false;
  bar.title.textContent = 'הנתונים שלך';
  mount('tpl-stats');

  const [aggRows, outbox, servedKeys, total] = await Promise.all([
    db.all('agg'), db.all('outbox'), db.allKeys('served'), db.count('items')
  ]);
  const rating = await db.getMeta('rating', START_RATING);
  const named = (id) => (taxonomy?.nodes || []).find(n => n.id === id)?.titleHe || id;

  const tops = aggRows.filter(r => !r.skillId.includes('.'));
  const leaves = aggRows.filter(r => r.skillId.split('.').length >= 2 && r.total >= 3)
    .map(r => ({ ...r, w: E.weakness(r) }))
    .sort((a, b) => b.w - a.w);

  document.getElementById('statsBody').innerHTML = `
    <div class="plate">
      <div class="plate__row"><span class="plate__k">דירוג נוכחי</span>
        <span class="plate__v num">${rating}</span></div>
      <div class="plate__row"><span class="plate__k">קושי היעד לשאלה הבאה</span>
        <span class="plate__v num">${E.targetDifficulty(rating)}</span></div>
      <div class="plate__row"><span class="plate__k">תשובות שנרשמו</span>
        <span class="plate__v num">${outbox.length}</span></div>
      <div class="plate__row"><span class="plate__k">שאלות שנצפו</span>
        <span class="plate__v num">${servedKeys.length} / ${total}</span></div>
    </div>

    <h2 class="sect">לפי תחום</h2>
    ${tops.length ? tops.map(r => `
      <div class="weak__row">
        <div class="weak__top">
          <span class="weak__name">${named(r.skillId)}</span>
          <span class="weak__pct">${Math.round(100 * r.correct / r.total)}% · ${r.total}</span>
        </div>
        <div class="weak__bar"><span style="width:${Math.round(100 * r.correct / r.total)}%"
          ${r.correct / r.total >= 0.75 ? 'data-ok="1"' : ''}></span></div>
      </div>`).join('')
      : '<div class="weak__empty">עוד אין נתונים.</div>'}

    <h2 class="sect">כל הנושאים, מהחלש לחזק</h2>
    ${leaves.length ? leaves.map(r => `
      <div class="weak__row">
        <div class="weak__top">
          <span class="weak__name">${named(r.skillId)}</span>
          <span class="weak__pct">${Math.round(100 * r.correct / r.total)}% · ${r.total}</span>
        </div>
        <div class="weak__bar"><span style="width:${Math.round(100 * r.correct / r.total)}%"
          ${r.correct / r.total >= 0.75 ? 'data-ok="1"' : ''}></span></div>
      </div>`).join('')
      : '<div class="weak__empty">צריך לפחות 3 תשובות בנושא כדי שהוא יופיע כאן.</div>'}
  `;

  document.getElementById('reset').addEventListener('click', async () => {
    if (!confirm('לאפס את כל ההתקדמות? כל השאלות יחזרו להיות זמינות.')) return;
    await db.clear(['served', 'outbox', 'agg']);
    await db.setMeta('rating', START_RATING);
    home();
  });
}

/* ── עזר ─────────────────────────────────────────────────────────── */
function mount(tplId) {
  speech.stopAll();          // אודיו שממשיך לנגן אחרי מעבר מסך הוא באג מבלבל
  view.innerHTML = '';
  view.appendChild(document.getElementById(tplId).content.cloneNode(true));
  scrollTo(0, 0);
}


/* ══════════════════════════════════════════════════════════════════
   אוצר המילים
   ══════════════════════════════════════════════════════════════════ */
async function vocabScreen() {
  session = null;
  bar.back.hidden = false;
  bar.line.hidden = true;
  bar.title.textContent = 'אוצר המילים שלי';
  mount('tpl-vocab');

  const input = document.getElementById('wordIn');
  const btn = document.getElementById('addWord');
  const note = document.getElementById('addNote');

  const setNote = (text, tone) => {
    note.textContent = text;
    if (tone) note.dataset.tone = tone; else delete note.dataset.tone;
  };

  if (!cloud.configured()) {
    setNote('הוספת מילים דורשת חיבור ל-Firebase. מלא את js/config.js.', 'bad');
    btn.disabled = true; input.disabled = true;
  } else if (!cloud.uid()) {
    setNote('צריך להתחבר כדי להוסיף מילים. ההתחברות במסך הבית.', 'bad');
    btn.disabled = true; input.disabled = true;
  }

  const submit = async () => {
    const term = input.value.trim();
    if (!term) return;

    btn.disabled = true;
    setNote('מחפש תרגום, דוגמה והגייה…');

    const res = await vocab.addWord(term);

    if (!res.ok) {
      setNote(res.reason, 'bad');
      btn.disabled = false;
      return;
    }

    input.value = '';
    btn.disabled = false;
    setNote(
      res.cached
        ? `${res.entry.term} נוספה. ההעשרה כבר הייתה במאגר, אז זה לא עלה כלום.`
        : `${res.entry.term} נוספה ונכנסה לתרגול.`,
      'good'
    );
    renderVocab();
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  renderVocab();
}

async function renderVocab() {
  const host = document.getElementById('vocabList');
  if (!host) return;

  const [entries, scores] = await Promise.all([vocab.list(), vocab.stats()]);

  if (!entries.length) {
    host.innerHTML = `<div class="vlist__empty">
      עוד לא הוספת מילים.<br><br>
      כל מילה שתוסיף הופכת לשלוש שאלות: תרגום מעברית, השלמה במשפט,
      וזיהוי משמעות. הן נכנסות לאותו תרגול כמו שאר השאלות, ולערכת מצב הטיסה.
    </div>`;
    return;
  }

  host.innerHTML = entries.map(e => {
    const sc = scores.get(e.slug) || { total: 0, correct: 0 };
    const pct = sc.total ? Math.round(100 * sc.correct / sc.total) : null;
    return `
    <div class="vlist__row" data-slug="${e.slug}">
      <div class="vlist__top">
        <span class="vlist__term" dir="ltr">${esc(e.term)}</span>
        <span class="vlist__he">${esc((e.hebrew || []).join(' · '))}</span>
      </div>
      ${e.ipaRP ? `<div class="vlist__ipa" dir="ltr">/${esc(e.ipaRP)}/ · ${esc(e.pos || '')} · ${esc(e.register || '')}</div>` : ''}
      ${e.exampleEn ? `<div class="vlist__ex" dir="ltr">${esc(e.exampleEn)}</div>` : ''}
      ${e.exampleHe ? `<div class="vlist__exhe">${esc(e.exampleHe)}</div>` : ''}
      ${e.noteHe ? `<div class="vlist__note">${esc(e.noteHe)}</div>` : ''}
      <div class="vlist__bar">
        <button class="vbtn vbtn--play" data-play="${e.slug}"
          ${e.audioSentenceHash || e.audioWordHash ? '' : 'disabled'}>▶ השמע</button>
        <button class="vbtn vbtn--del" data-del="${e.slug}">מחק</button>
        <span class="vlist__score">${pct === null ? 'טרם תורגלה' : `${pct}% · ${sc.total} תשובות`}</span>
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('[data-play]').forEach(b =>
    b.addEventListener('click', async () => {
      const e = entries.find(x => x.slug === b.dataset.play);
      const hash = e?.audioSentenceHash || e?.audioWordHash;
      const url = vocab.audioUrl(hash);
      if (!url) return;
      try { await new Audio(url).play(); }
      catch { b.textContent = 'לא זמין'; b.disabled = true; }
    }));

  host.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const e = entries.find(x => x.slug === b.dataset.del);
      if (!confirm(`למחוק את "${e.term}"? השאלות שנוצרו ממנה יוסרו מהתרגול.`)) return;
      await vocab.removeWord(b.dataset.del);
      renderVocab();
    }));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
