/* ══════════════════════════════════════════════════════════════════
   sw.js — Service Worker.

   חייב לשבת בשורש: הוא שולט רק על התיקייה שבה הוא נמצא ומטה.
   זו הסיבה היחידה והמספקת לכך שהאפליקציה לא יכולה להיות קובץ אחד.

   אסטרטגיה:
     קליפת האפליקציה  → precache, מטמון־תחילה
     חבילות תוכן      → רשת־תחילה עם נפילה למטמון (נשמרות ב-IndexedDB בכל מקרה)
     שאר הבקשות       → רשת בלבד

   העדכון לא מופעל אוטומטית. מחליפים גרסה רק כשהמשתמש מאשר, אחרת
   אפשר להחליף אפליקציה תחת מישהו באמצע סבב ולאבד לו תשובות.
   ══════════════════════════════════════════════════════════════════ */

const VERSION = 'v4.0.0';
const SHELL = `shell-${VERSION}`;
const DATA  = `data-${VERSION}`;

/* ── מטמון האודיו לא נושא מספר גרסה, וזה בכוונה ──────────────────
   האודיו הוא הדבר היקר: עשרות מגה־בייט שהמשתמש הוריד מראש לקראת
   טיסה. אם השם היה כולל גרסה, כל פריסה של תיקון טיפוגרפי הייתה
   מוחקת אותו. הקבצים ממילא נושאים גיבוב בשם, אז אין סכנת התיישנות. */
const AUDIO = 'audio-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/engine.js',
  './js/games.js',
  './js/cloud.js',
  './js/sync.js',
  './js/config.js',
  './js/kit.js',
  './js/vocab.js',
  './js/speech.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const DATA_FILES = [
  './data/taxonomy.json',
  './data/packs/grammar-core-v1.json',
  './data/packs/lexis-british-v1.json',
  './data/packs/listening-rp-v1.json',
  './data/packs/reading-games-v1.json',
  './data/packs/speaking-rp-v1.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    const data = await caches.open(DATA);
    await data.addAll(DATA_FILES);
    // בלי skipWaiting — הגרסה החדשה ממתינה עד שכל הלשוניות נסגרות
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, AUDIO]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Firebase נטען מ-CDN ומדבר עם שרתי גוגל. לא נוגעים בזה:
  // ה-SDK מנהל את הרשת שלו, וכל התערבות כאן רק תשבור אותו.
  // מבחינת אופליין זה בסדר גמור — הסנכרון הוא תוספת, לא תלות.
  if (url.origin !== self.location.origin) return;

  // בדיקת הרשת של sync.js חייבת להגיע לרשת האמיתית, אחרת היא
  // תמיד תענה "מחובר" מהמטמון ותשקר בדיוק כמו navigator.onLine.
  if (url.searchParams.has('probe')) return;

  // ניווט — תמיד מחזירים את קליפת האפליקציה
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      return cached || fetch(req);
    })());
    return;
  }

  // אודיו — מטמון קודם, תמיד. הקבצים נושאים גיבוב בשם ולכן לעולם
  // לא משתנים. אם קובץ לא במטמון, זה אומר שהוא לא הורד — ובטיסה
  // אין מאיפה להביא אותו, אז מחזירים 504 והמשחק מדלג על הפריט.
  if (url.pathname.includes('/audio/')) {
    e.respondWith((async () => {
      const cached = await caches.match(req, { cacheName: AUDIO });
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(AUDIO)).put(req, fresh.clone());
        return fresh;
      } catch {
        return new Response('', { status: 504, statusText: 'audio not downloaded' });
      }
    })());
    return;
  }

  // חבילות תוכן — רשת קודם, כדי לקבל עדכוני תוכן, עם נפילה למטמון
  if (url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(DATA);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw new Error('אין רשת ואין עותק במטמון');
      }
    })());
    return;
  }

  // שאר הקליפה — מטמון קודם
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok) (await caches.open(SHELL)).put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response('לא זמין אופליין', { status: 503 });
    }
  })());
});
