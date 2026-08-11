/* ══════════════════════════════════════════════════════════════════
   engine.js — המנוע האדפטיבי.

   כל מה שכאן הוא פונקציות טהורות: נכנס מידע, יוצאת החלטה.
   אין קריאות לרשת, אין IndexedDB, אין DOM.
   זה מה שמאפשר לבדוק את אלגוריתם הבחירה בלי לשחק 200 סבבים ידנית.
   ══════════════════════════════════════════════════════════════════ */

/* ── נירמול טקסט להשוואת תשובות ─────────────────────────────────────
   שומר גרשים (I'll, don't, flat's) ומוריד כל שאר הפיסוק.            */
export function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const eq = (a, b) => normalise(a) === normalise(b);

/* ── בדיקת תשובה ───────────────────────────────────────────────────
   מחזיר { correct, expected } — expected הוא מה שהיה צריך לענות,
   לתצוגה במשוב.                                                     */
export function checkAnswer(item, response) {
  switch (item.type) {
    case 'mcq':
    case 'minimal_pair':
      return { correct: response === item.answer, expected: item.options[item.answer] };

    case 'cloze':
      return {
        correct: item.accepted.some(a => eq(a, response)),
        expected: item.accepted[0]
      };

    case 'translate':
      return {
        correct: item.accepted.some(a => eq(a, response)),
        expected: item.accepted[0]
      };

    case 'error_spot':
      return {
        correct: eq(response, item.errorSpan),
        expected: item.errorSpan
      };

    case 'order':
      return { correct: eq(response, item.solution), expected: item.solution };

    case 'wordle':
      return { correct: eq(response, item.target), expected: item.target };

    default:
      return { correct: false, expected: '' };
  }
}

/* ── מה המשפט המתוקן נראה כמו ───────────────────────────────────── */
export function correctedSentence(item) {
  if (item.type !== 'error_spot') return '';
  return item.sentence.replace(item.errorSpan, item.correction);
}

/* ── גבול תחתון של Wilson ───────────────────────────────────────────
   למה לא פשוט אחוז הצלחה: 1 מתוך 2 נותן 50%, אבל זה כמעט חסר מידע.
   Wilson מחזיר הערכה שמרנית שמתחשבת בכמות הנתונים, כך שנושא לא
   מוכרז כחולשה על סמך שתי תשובות.                                   */
export function wilsonLower(correct, total, z = 1.96) {
  if (total === 0) return 0;
  const p = correct / total;
  const d = 1 + z * z / total;
  const c = p + z * z / (2 * total);
  const s = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.max(0, (c - s) / d);
}

/* ── ציון חולשה ────────────────────────────────────────────────────
   0 = חזק, 1 = חלש. שלושה גורמים: דיוק, כמה נתונים יש, וכמה זמן עבר. */
export function weakness(stat, now = Date.now()) {
  if (!stat || !stat.total) return 0.5;                 // לא ידוע — עדיפות בינונית
  const acc  = wilsonLower(stat.correct, stat.total);
  const days = (now - (stat.lastSeenAt || now)) / 86400000;
  const rust = Math.min(0.2, days / 60);                // עד 0.2 תוספת על שכחה
  const thin = stat.total < 5 ? 0.1 : 0;                // מעט נתונים — כדאי לבדוק שוב
  return Math.min(1, (1 - acc) + rust + thin);
}

/* ── Elo ───────────────────────────────────────────────────────────
   דירוג כפול: למשתמש ולפריט. הקושי של הפריטים מכייל את עצמו לפי
   נתוני שימוש אמיתיים, במקום להסתמך על תיוג ידני שלרוב שגוי.        */
export function expectedScore(userRating, itemRating) {
  return 1 / (1 + Math.pow(10, (itemRating - userRating) / 400));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function updateRatings(userRating, itemRating, correct, attempts = 99) {
  const k = attempts < 20 ? 48 : attempts < 60 ? 32 : 20;  // מהיר בהתחלה, יציב אחר כך
  const exp = expectedScore(userRating, itemRating);
  const s = correct ? 1 : 0;
  return {
    user: clamp(Math.round(userRating + k * (s - exp)), 800, 2000),
    item: clamp(Math.round(itemRating - (k / 3) * (s - exp)), 800, 2000),
    expected: exp
  };
}

/* ── כיול הרצועה ───────────────────────────────────────────────────
   תיקון על סמך 20 התשובות האחרונות. שים לב שהוא מוחל על קושי היעד
   ולא על הדירוג עצמו — אחרת הוא מצטבר בכל שאלה והדירוג בורח.       */
export function bandAdjust(recent) {
  if (recent.length < 8) return 0;
  const window = recent.slice(-20);
  const acc = window.reduce((a, b) => a + b, 0) / window.length;
  if (acc > 0.85) return +60;   // קל מדי
  if (acc < 0.60) return -60;   // קשה מדי
  return 0;
}

/* ── קושי היעד ─────────────────────────────────────────────────────
   רצועת היעד היא 70-85% הצלחה. עבור p≈0.78 ההפרש הוא כ-220 נקודות
   מתחת לדירוג המשתמש. מעל זה משעמם, מתחת זה מתסכל.                  */
export function targetDifficulty(userRating, recent = []) {
  return Math.round(clamp(userRating, 800, 2000) - 220 + bandAdjust(recent));
}

/* ── בחירת השאלה הבאה ──────────────────────────────────────────────
   60% חולשה · 25% חיזוק נושאים שנפלת בהם · 15% גילוי.
   בתוך הנושא שנבחר — הפריט שהקושי שלו הכי קרוב ליעד.                */
export function pickNext({ candidates, agg, userRating, recent = [], rand = Math.random }) {
  if (!candidates.length) return null;

  const bySkill = new Map();
  for (const it of candidates) {
    if (!bySkill.has(it.skill)) bySkill.set(it.skill, []);
    bySkill.get(it.skill).push(it);
  }

  const skills = [...bySkill.keys()];
  const stat = (s) => agg[s] || null;

  const weak    = skills.filter(s =>  stat(s) && weakness(stat(s)) >= 0.4);
  const shaky   = skills.filter(s =>  stat(s) && stat(s).lastWrong);
  const unseen  = skills.filter(s => !stat(s));

  const roll = rand();
  let pool;
  if      (roll < 0.60 && weak.length)   pool = weak;
  else if (roll < 0.85 && shaky.length)  pool = shaky;
  else if (unseen.length)                pool = unseen;
  else                                   pool = weak.length ? weak : skills;

  // הגרלה משוקללת לפי ציון החולשה, כדי שלא ניתקע על אותו נושא
  const weights = pool.map(s => 0.15 + weakness(stat(s)));
  const totalW  = weights.reduce((a, b) => a + b, 0);
  let r = rand() * totalW, chosen = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) { chosen = pool[i]; break; }
  }

  const target = targetDifficulty(userRating, recent);
  const list = bySkill.get(chosen);
  return list.reduce((best, it) =>
    Math.abs(it.difficulty - target) < Math.abs(best.difficulty - target) ? it : best
  );
}

/* ── עדכון סטטיסטיקה ───────────────────────────────────────────────
   מחזיר שורות agg מעודכנות לכל צומת בשרשרת הנושא:
   grammar.tenses.present_perfect מעדכן גם את grammar.tenses וגם grammar. */
export function skillChain(skillId) {
  const parts = skillId.split('.');
  return parts.map((_, i) => parts.slice(0, i + 1).join('.'));
}

export function applyAttempt(agg, item, correct, now = Date.now()) {
  const rows = [];
  for (const skillId of skillChain(item.skill)) {
    const prev = agg[skillId] || { skillId, total: 0, correct: 0, recent: [] };
    const recent = [...(prev.recent || []), correct ? 1 : 0].slice(-20);
    rows.push({
      skillId,
      total: prev.total + 1,
      correct: prev.correct + (correct ? 1 : 0),
      recent,
      lastSeenAt: now,
      lastWrong: correct ? false : true
    });
  }
  return rows;
}

/* ── ניחוש מילה: צביעת אותיות ───────────────────────────────────────
   טיפול נכון באותיות כפולות: מסמנים קודם פגיעות מדויקות, ורק אחר כך
   מחלקים את מה שנשאר. בלי זה "queue" נותן סימון שגוי.                */
export function scoreGuess(guess, target) {
  const g = guess.toLowerCase().split('');
  const t = target.toLowerCase().split('');
  const marks = new Array(g.length).fill('miss');
  const pool = {};

  for (let i = 0; i < g.length; i++) {
    if (g[i] === t[i]) marks[i] = 'hit';
    else pool[t[i]] = (pool[t[i]] || 0) + 1;
  }
  for (let i = 0; i < g.length; i++) {
    if (marks[i] === 'hit') continue;
    if (pool[g[i]] > 0) { marks[i] = 'near'; pool[g[i]]--; }
  }
  return marks;
}

/* ── מזהה ניסיון ───────────────────────────────────────────────────
   נוצר במכשיר. בשלב 2 הוא יהפוך למזהה המסמך ב-Firestore, וזה מה
   שיהפוך את הסנכרון לאידמפוטנטי — ניסיון חוזר כותב בדיוק אותו דבר.  */
export function newAttemptId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ══════════════════════════════════════════════════════════════════
   ערכת מצב טיסה — לוח חזרות, הרכבה, ותכנון אודיו

   הבהרה על "לא לפגוש את אותה שאלה פעמיים":
   הדרישה מתקיימת *בתוך ערכה*. הערכה היא רשימה סגורה בלי כפילויות.
   בין ערכות זה בכוונה אחרת — חזרה מרווחת מחייבת שפריט שנפלת בו יחזור.
   בלי זה יש מדידה, אין למידה.
   ══════════════════════════════════════════════════════════════════ */

/* מרווחים בימים. קצרים מ-SM-2 קלאסי, כי אלה תרגילי דקדוק ולא
   כרטיסיות אוצר מילים — הם נשכחים אחרת.                            */
export const SCHEDULE_STEPS = [3, 7];

/* ── לוח החזרות ────────────────────────────────────────────────────
   נכון בפעם הראשונה  → מחזיר null. הפריט פורש ולא נכנס ללוח בכלל.
   טעות                → חוזר מחר, וה-ease יורד.
   נכון אחרי טעות      → מתרחק צעד אחד בכל פעם, עד סיום הסולם.

   ההחזרה של null היא לא מקרה קצה אלא החלטה: אין טעם לתזמן חזרה על
   משהו שידעת מיד. זה מה ששומר על לוח החזרות קטן ורלוונטי.          */
export function scheduleAfter(prev, correct, now = Date.now()) {
  if (!prev) {
    if (correct) return null;                       // ידעת — פורש
    return { reps: 0, lapses: 1, ease: 2.1, intervalDays: 1,
             due: now + 86400000, lastAt: now };
  }

  if (!correct) {
    return {
      reps: 0,
      lapses: (prev.lapses || 0) + 1,
      ease: Math.max(1.3, (prev.ease ?? 2.1) - 0.25),
      intervalDays: 1,
      due: now + 86400000,
      lastAt: now
    };
  }

  const reps = (prev.reps || 0) + 1;
  if (reps > SCHEDULE_STEPS.length) return null;    // שלוש חזרות נקיות — פורש

  const ease = Math.min(2.8, (prev.ease ?? 2.1) + 0.08);
  const intervalDays = SCHEDULE_STEPS[reps - 1];
  return {
    reps, lapses: prev.lapses || 0,
    ease: Math.round(ease * 100) / 100,
    intervalDays,
    due: now + intervalDays * 86400000,
    lastAt: now
  };
}

/* ── חישוב מחדש מיומן האירועים ──────────────────────────────────────
   פונקציה דטרמיניסטית: אותן תשובות תמיד נותנות אותו לוח, בכל מכשיר,
   בלי קשר לסדר שבו הן הגיעו מהסנכרון. אותו עיקרון בדיוק כמו המונים
   בשלב 2 — מצב נגזר ולא מצב שצריך למזג.                            */
export function replaySchedule(attempts) {
  const byItem = new Map();
  const ordered = [...attempts].sort(
    (a, b) => (a.clientCreatedAt || 0) - (b.clientCreatedAt || 0));
  for (const a of ordered) {
    const next = scheduleAfter(byItem.get(a.itemId) || null, !!a.correct, a.clientCreatedAt);
    if (next) byItem.set(a.itemId, next);
    else byItem.delete(a.itemId);
  }
  return byItem;
}

/* ══════════════════════════════════════════════════════════════════
   הרכבת הערכה

     45%  חולשות שזוהו
     25%  חזרה מתוזמנת
     15%  שימור נושאים חזקים
     15%  גילוי

   בלי המרכיב האחרון הערכה מרגישה כמו עונש. בלי הראשון היא מבזבזת
   את הטיסה. דלי שלא מתמלא לא מבזבז מקום — ההשלמה עוברת לשאר.
   ══════════════════════════════════════════════════════════════════ */
export const KIT_MIX = { weak: 0.45, review: 0.25, retain: 0.15, discover: 0.15 };

/* תקרה לכל נושא. בלי זה ערכה של 400 שאלות על Present Perfect היא
   תוצאה חוקית לגמרי של "תרגל את החולשות שלך" — ובטיסה זה בלתי נסבל.
   התקרה היא מה שהופך את הערכה למגוונת ולא רק לממוקדת.              */
export const MAX_SHARE_PER_SKILL = 0.15;

/* אוצר מילים אישי מקבל תקרה גבוהה יותר, ומסיבה טובה: כל המילים
   שלך יושבות תחת צומת אחד (lexis.personal), ולכן התקרה הרגילה
   הייתה חוסמת אותן כאילו הן נושא אחד משעמם.

   אבל אלה מילים שאתה בחרת. אם הוספת 60 מילים לפני נסיעה, זה בדיוק
   מה שאתה רוצה לתרגל בטיסה. 15% היו מכניסים 15 מילים מתוך 60.

   40% ולא 100%: הערכה עדיין צריכה דקדוק והאזנה, אחרת אין למידה
   אלא רק שינון.                                                    */
export const MAX_SHARE_PERSONAL = 0.40;

export function composeKit({
  fresh = [], dueItems = [], agg = {}, userRating = 1450,
  size = 300, now = Date.now(), rand = Math.random
} = {}) {

  const target = targetDifficulty(userRating);
  const nearTarget = (a, b) =>
    Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target);

  const weak = [], retain = [], discover = [];
  for (const it of fresh) {
    const st = agg[it.skill];
    if (!st || st.total < 3) discover.push(it);
    else if (weakness(st, now) >= 0.4) weak.push(it);
    else retain.push(it);
  }

  // בתוך כל דלי: הכי רלוונטי קודם
  weak.sort((a, b) => {
    const d = weakness(agg[b.skill], now) - weakness(agg[a.skill], now);
    return d !== 0 ? d : nearTarget(a, b);
  });
  retain.sort(nearTarget);
  shuffleInPlace(discover, rand);
  const due = [...dueItems].sort((a, b) => (a._due || 0) - (b._due || 0));

  const buckets = [
    ['review',   due,      Math.round(size * KIT_MIX.review)],
    ['weak',     weak,     Math.round(size * KIT_MIX.weak)],
    ['retain',   retain,   Math.round(size * KIT_MIX.retain)],
    ['discover', discover, Math.round(size * KIT_MIX.discover)]
  ];

  const picks = [];
  const taken = new Set();
  const perSkill = {};
  const breakdown = { weak: 0, review: 0, retain: 0, discover: 0, filler: 0 };
  const skillCap = Math.max(1, Math.floor(size * MAX_SHARE_PER_SKILL));

  // חזרה מתוזמנת פטורה מתקרת הנושא: אלה פריטים שכבר נפלת בהם,
  // ואין טעם לדחות אותם רק בגלל שהם מרוכזים בנושא אחד.
  const personalCap = Math.max(1, Math.floor(size * MAX_SHARE_PERSONAL));

  const place = (it, name, capped) => {
    if (taken.has(it.id) || picks.length >= size) return false;
    const cap = it.personal ? personalCap : skillCap;
    if (capped && (perSkill[it.skill] || 0) >= cap) return false;
    taken.add(it.id);
    perSkill[it.skill] = (perSkill[it.skill] || 0) + 1;
    picks.push(it);
    breakdown[name]++;
    return true;
  };

  for (const [name, pool, want] of buckets) {
    const capped = name !== 'review';
    for (const it of pool) {
      if (breakdown[name] >= want || picks.length >= size) break;
      place(it, name, capped);
    }
  }

  // השלמה: דלי שלא התמלא לא מבזבז מקום. נספר בנפרד כדי שההרכב
  // שמוצג למשתמש ישקף את מה שבאמת קרה ולא את מה שתכננו.
  if (picks.length < size) {
    for (const [, pool] of buckets) {
      for (const it of pool) {
        if (picks.length >= size) break;
        place(it, 'filler', true);
      }
      if (picks.length >= size) break;
    }
  }

  return {
    picks, breakdown,
    skillsCovered: new Set(picks.map(p => p.skill)).size
  };
}

function shuffleInPlace(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ══════════════════════════════════════════════════════════════════
   תכנון האודיו

   האודיו הוא כל הסיפור מבחינת מקום: הטקסט של הבנק כולו הוא כמגה
   וחצי, וקטע אודיו בודד יכול להיות 40KB. לכן הקיצוץ מתחיל תמיד באודיו.

   סדר העדיפות:
     1. פריטים שבלי אודיו אין בהם שאלה בכלל (זוגות מינימליים, הכתבה)
     2. פריטים שהאודיו בהם בונוס (ניב עם הקראה)

   פריט מהקבוצה הראשונה שלא נכנס לתקציב נופל מהערכה. שאלה שאי אפשר
   לענות עליה בטיסה גרועה יותר מערכה קטנה יותר.
   מהקבוצה השנייה — רק האודיו יורד, השאלה נשארת.
   ══════════════════════════════════════════════════════════════════ */
export const AUDIO_REQUIRED_TYPES = ['minimal_pair', 'dictation'];
const SAFE_FRACTION = 0.85;      // לא ממלאים את המכשיר עד הסוף

export function planAudio({ picks, manifest, capBytes, freeBytes = Infinity }) {
  const byItem = manifest?.byItem || {};
  const files  = manifest?.files  || {};
  const budget = Math.max(0, Math.min(capBytes, Math.floor(freeBytes * SAFE_FRACTION)));

  const required = [], optional = [], dropItemIds = [];

  for (const it of picks) {
    const needs = AUDIO_REQUIRED_TYPES.includes(it.type);
    const hash = byItem[it.id];
    const bytes = hash ? files[hash] : undefined;

    if (!hash || bytes === undefined) {
      if (needs) dropItemIds.push(it.id);      // אין קובץ — אין שאלה
      continue;
    }
    (needs ? required : optional).push({ id: it.id, hash, bytes });
  }

  const chosen = new Set();
  let used = 0;
  let skippedOptional = 0;

  // אותו טקסט יכול לשרת כמה פריטים — הגיבוב זהה, והבתים נספרים פעם אחת
  const take = (entry) => {
    if (chosen.has(entry.hash)) return true;
    if (used + entry.bytes > budget) return false;
    chosen.add(entry.hash);
    used += entry.bytes;
    return true;
  };

  for (const e of required) {
    if (!take(e)) dropItemIds.push(e.id);
  }
  for (const e of optional) {
    if (!take(e)) skippedOptional++;
  }

  return {
    hashes: [...chosen],
    bytes: used,
    budget,
    dropItemIds,
    skippedOptional
  };
}

export const fmtBytes = (n) => {
  if (!n) return '0';
  const mb = n / 1048576;
  if (mb >= 100) return Math.round(mb) + 'MB';
  if (mb >= 1) return mb.toFixed(1) + 'MB';
  return Math.max(1, Math.round(n / 1024)) + 'KB';
};

/* ══════════════════════════════════════════════════════════════════
   שלב 5 — ניקוד הגייה

   ── מגבלה שחייבים להכיר לפני שמסתכלים על הציון ──
   מנוע זיהוי הדיבור בדפדפן הוא מנוע *שפה*, לא מנוע פונטיקה. הוא
   מנחש את המילה הסבירה ביותר, ולכן הוא נוטה לתקן אותך בשקט:
   תגיד "I sink so" והוא יכתוב "I think so", כי זה מה שהגיוני.

   המשמעות: הניקוד כאן **מזהה פחות שגיאות ממה שבאמת עשית**, ולא
   יותר. ציון גבוה הוא לא הוכחה להגייה נכונה. ציון נמוך, לעומת זאת,
   כמעט תמיד אמיתי — כי המנוע היה צריך להתאמץ כדי לטעות.

   ── מכאן נגזרת החלוקה ──
   מילים בודדות וזוגות מינימליים  → ניקוד אמין. אין הקשר שיתקן אותך.
   משפטים שלמים                    → חיקוי בלבד, אתה שופט באוזן.

   זו לא פשרה טכנית אלא הדרך הנכונה למדוד: ship מול sheep במילה
   בודדת הוא בדיוק המקום שבו המנוע לא יכול לכסות עליך.
   ══════════════════════════════════════════════════════════════════ */

/* ── טבלת הבלבולים של דוברי עברית ──────────────────────────────────
   כל כלל הוא טרנספורמציה: אם החלת הכלל על מילת היעד מייצרת בדיוק
   את מה שהמנוע שמע — זיהינו את דפוס הטעות, לא רק את העובדה שטעית.
   זה ההבדל בין "לא נכון" לבין "הצליל th יצא כמו t".               */
/* הערה על מה שלא נמצא כאן: th→f ("three" כ-"free").
   זו תופעה אמיתית באנגלית, אבל היא מאפיין של מבטאי לונדון עממיים
   ולא של דוברי עברית. דוברי עברית מחליפים th ב-t, s או d.
   הכלל הזה היה קיים כאן וגרם לאבחון שווא: thirty → forty סומן
   כשגיאת th, בעוד שזה כמעט תמיד בלבול מספרים של מנוע הזיהוי.
   אבחון שגוי גרוע מאין אבחון — הוא שולח אותך לתרגל בעיה שאין לך. */
export const CONFUSIONS = [
  { tag: 'he.th_sound', titleHe: 'הצליל th יצא כמו t',
    rules: [[/^th/i, 't'], [/th$/i, 't'], [/th/gi, 't']] },
  { tag: 'he.th_sound', titleHe: 'הצליל th יצא כמו s',
    rules: [[/^th/i, 's'], [/th$/i, 's'], [/th/gi, 's']] },
  { tag: 'he.th_sound', titleHe: 'הצליל th הקולי יצא כמו d',
    rules: [[/^th/i, 'd'], [/th/gi, 'd']] },

  { tag: 'he.w_v', titleHe: 'w הפכה ל-v',
    rules: [[/^w/i, 'v'], [/w/gi, 'v']] },
  { tag: 'he.w_v', titleHe: 'v הפכה ל-w',
    rules: [[/^v/i, 'w'], [/v/gi, 'w']] },
  { tag: 'he.w_v', titleHe: 'wh נשמעה כ-v',
    rules: [[/^wh/i, 'v']] },

  { tag: 'he.ship_sheep', titleHe: 'תנועה קצרה יצאה ארוכה',
    rules: [[/i/i, 'ee'], [/^([bcdfghjklmnpqrstvwxyz]+)i/i, '$1ee']] },
  { tag: 'he.ship_sheep', titleHe: 'תנועה ארוכה יצאה קצרה',
    rules: [[/ee/i, 'i'], [/ea/i, 'i']] },

  { tag: 'he.ae_vowel', titleHe: 'התנועה æ יצאה כמו e',
    rules: [[/a/i, 'e']] },
  { tag: 'he.ae_vowel', titleHe: 'התנועה e יצאה כמו æ',
    rules: [[/e/i, 'a']] },

  { tag: 'he.initial_clusters', titleHe: 'נוספה תנועה לפני צרור עיצורים',
    rules: [[/^s([ptkmnlw])/i, 'es$1'], [/^s([ptkmnlw])/i, 'is$1']] },

  { tag: 'rp.non_rhotic', titleHe: 'r נהגתה במקום שב-RP היא שותקת',
    rules: [[/r(?=[bcdfghjklmnpqstvwxyz]|$)/gi, '']] }
];

/* שלד עיצורים: מוריד תנועות ומכווץ כפילויות.
   נחוץ כי שגיאת עיצור בכתיב התמלול גוררת לעיתים גם שינוי תנועה —
   they נשמע day, ולא dey כפי שכלל אות־לאות היה מנבא. השוואת
   השלד מזהה שהעיצורים זהים ושרק ה-th הוא הסיפור.                */
const skeleton = (w) =>
  String(w).toLowerCase().replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');

/* מפעיל את הכללים ומחזיר את דפוס הבלבול, אם יש.

   ההתאמה נעשית בשתי רמות, והסדר חשוב:
     1. התאמה מדויקת — three → tree. חד־משמעי.
     2. התאמת שלד — they → dey ≈ day. רק *אחרי* שכלל שינה משהו,
        אחרת כל שתי מילים עם אותם עיצורים היו נחשבות דפוס.       */
export function diagnoseSubstitution(target, heard) {
  const t = normalise(target), h = normalise(heard);
  if (!t || !h || t === h) return null;

  let loose = null;

  for (const c of CONFUSIONS) {
    for (const [from, to] of c.rules) {
      const fwd = normalise(t.replace(from, to));
      const rev = normalise(h.replace(from, to));

      // רמה 1: התאמה מדויקת, לשני הכיוונים
      if (fwd === h || rev === t) return { tag: c.tag, titleHe: c.titleHe };

      // רמה 2: הכלל שינה משהו, והעיצורים שנותרו זהים
      if (!loose) {
        if (fwd !== t && skeleton(fwd) === skeleton(h)) loose = { tag: c.tag, titleHe: c.titleHe };
        else if (rev !== h && skeleton(rev) === skeleton(t)) loose = { tag: c.tag, titleHe: c.titleHe };
      }
    }
  }
  return loose;
}

/* ── יישור מילים ────────────────────────────────────────────────────
   Levenshtein ברמת מילים, עם שחזור המסלול. מחזיר רצף פעולות, כי
   המשתמש צריך לראות *איזו* מילה נפלה ולא רק שהיה הבדל.           */
export function alignWords(targetWords, heardWords) {
  const n = targetWords.length, m = heardWords.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = normalise(targetWords[i - 1]) === normalise(heardWords[j - 1]);
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (same ? 0 : 1)
      );
    }
  }

  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const same = i > 0 && j > 0 &&
      normalise(targetWords[i - 1]) === normalise(heardWords[j - 1]);
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (same ? 0 : 1)) {
      ops.unshift(same
        ? { op: 'hit', target: targetWords[i - 1], heard: heardWords[j - 1] }
        : { op: 'sub', target: targetWords[i - 1], heard: heardWords[j - 1] });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.unshift({ op: 'miss', target: targetWords[i - 1], heard: null });
      i--;
    } else {
      ops.unshift({ op: 'extra', target: null, heard: heardWords[j - 1] });
      j--;
    }
  }
  return ops;
}

/* ── ניקוד ──────────────────────────────────────────────────────────
   הציון הוא אחוז המילים שנקלטו נכון, מרוכך בביטחון של המנוע.
   מחזיר גם את דפוסי הטעות — זה החלק שבאמת מלמד.                  */
export function scorePronunciation({ target, heard, confidence = null, isolated = false }) {
  const tw = normalise(target).split(' ').filter(Boolean);
  const hw = normalise(heard).split(' ').filter(Boolean);

  if (!tw.length) return { score: 0, ops: [], patterns: [], reliable: false };
  if (!hw.length) {
    return {
      score: 0, ops: tw.map(t => ({ op: 'miss', target: t, heard: null })),
      patterns: [], reliable: false, empty: true
    };
  }

  const ops = alignWords(tw, hw);
  const hits = ops.filter(o => o.op === 'hit').length;
  const raw = hits / tw.length;

  // דפוסי טעות מתוך ההחלפות
  const patterns = [];
  const seen = new Set();
  for (const o of ops) {
    if (o.op !== 'sub') continue;
    const dx = diagnoseSubstitution(o.target, o.heard);
    if (dx && !seen.has(dx.titleHe)) {
      seen.add(dx.titleHe);
      patterns.push({ ...dx, target: o.target, heard: o.heard });
    }
  }

  // ביטחון נמוך מרכך את הציון במקום להעלים אותו: עדיף לומר
  // "לא הצלחתי לשמוע היטב" מאשר לתת ציון נמוך על רעש רקע.
  const conf = confidence == null ? 1 : Math.max(0, Math.min(1, confidence));
  const reliable = conf >= 0.6;
  const score = Math.round(100 * raw * (reliable ? 1 : 0.5 + conf / 2));

  return {
    score, ops, patterns, reliable,
    confidence: conf,
    exact: raw === 1,
    /* ניקוד של מילה בודדת אמין הרבה יותר: אין הקשר שיאפשר למנוע
       לתקן אותך בשקט. משפט שלם מקבל אזהרה מפורשת בממשק.         */
    trustworthy: isolated && reliable
  };
}

/* ── השוואת אורך להקלטת חיקוי ───────────────────────────────────────
   במצב אופליין אין תמלול, אבל אורך ההקלטה עדיין אומר משהו אמיתי:
   דוברי עברית נוטים להאריך משפטים באנגלית כי הם מבטאים כל הברה
   במלואה במקום להחליש אותן. זו לא בדיקת הגייה, וזה נאמר במפורש.  */
export function compareDuration(targetMs, yoursMs) {
  if (!targetMs || !yoursMs) return null;
  const ratio = yoursMs / targetMs;
  let verdictHe;
  if (ratio > 1.45) verdictHe = 'ההקלטה שלך ארוכה משמעותית. נסה להחליש הברות לא מוטעמות.';
  else if (ratio > 1.2) verdictHe = 'קצת יותר איטי מהמקור. שווה לנסות שוב בקצב טבעי.';
  else if (ratio < 0.7) verdictHe = 'מהיר מהמקור. ודא שלא בלעת מילים.';
  else verdictHe = 'הקצב שלך קרוב למקור.';
  return { ratio: Math.round(ratio * 100) / 100, verdictHe };
}
