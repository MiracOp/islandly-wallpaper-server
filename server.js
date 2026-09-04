import { createServer } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const DATA_FILE = process.env.DATA_FILE || join(__dirname, "data", "wallpapers.json");
const PUBLIC_DIR = join(__dirname, "public");

// ── GitHub sync ──────────────────────────────────────────────
// GITHUB_TOKEN tanımlıysa: her wallpaper değişikliği GitHub'a commit edilir,
// sunucu açılışta güncel veriyi GitHub'dan çeker (redeploy'da veri kaybolmaz).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "MiracOp/islandly-wallpaper-server";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATA_PATH = "data/wallpapers.json";
const CONFIG_FILE = process.env.CONFIG_FILE || join(__dirname, "data", "appconfig.json");
const GITHUB_CONFIG_PATH = "data/appconfig.json";
const GIFTS_FILE = process.env.GIFTS_FILE || join(__dirname, "data", "gifts.json");
const GITHUB_GIFTS_PATH = "data/gifts.json";
const EVENTS_FILE = process.env.EVENTS_FILE || join(__dirname, "data", "events.json");
const GITHUB_EVENTS_PATH = "data/events.json";
const PUSH_FILE = process.env.PUSH_FILE || join(__dirname, "data", "push.json");
const GITHUB_PUSH_PATH = "data/push.json";

// Uygulama görünüm ayarları (kar modu vb.) — panelden yönetilir
const DEFAULT_CONFIG = {
  theme: "default",
  // Duvar Kağıtları sekmesi — false yapınca uygulamada sekme hiç görünmez.
  // App Store'a yeni sürüm göndermeden kapatıp açmak için.
  wallpapersTabEnabled: true,
  snow: { enabled: false, intensity: 60, speed: 1, size: 1 },
  // Uygulama içi duyuru banner'ı — id değişince daha önce kapatan kullanıcıya tekrar gösterilir
  announcement: {
    enabled: false,
    id: "",
    emoji: "📣",
    title: "",
    message: "",
    ctaText: "",
    ctaAction: "none" // none | paywall | themes | pets
  },
  // Duvar kağıdı kategorileri — uygulama güncellemesi olmadan panelden kontrol.
  // Buradaki id'ler app'teki WallpaperCategory id'leriyle aynıdır; ayrıca
  // "Live" ve "Couples" özel raflarını da kapatmak için kullanılabilir.
  wallpapers: {
    disabledCategories: [],  // bu kategoriler duvar kağıdı sekmesinde hiç görünmez
    homeOrder: []            // ana sayfadaki kategori / raf sırası (id listesi)
  },
  // Tema yönetimi — uygulama güncellemesi olmadan panelden kontrol
  themes: {
    freeThemeNames: [],      // bu isimli temalar premium'suz kullanılabilir (app'teki isFree'ye ek)
    featuredThemeName: "",   // haftanın teması — listede öne çıkarılır
    disabledCategories: []   // bu kategoriler app'te gizlenir
  },
  // Paywall kontrolü — trial ve fiyat seti (A/B testi için product ID override)
  paywall: {
    trialEnabled: true,
    // Paywall açılınca gelen "🎁 Free Trial Unlocked!" tanıtım animasyonu.
    // trialEnabled'dan bağımsız: deneme açık kalıp animasyon kapatılabilir.
    trialAnimationEnabled: true,
    monthlyProductID: "",    // boş = app'teki varsayılan ID
    yearlyProductID: ""      // boş = app'teki varsayılan ID
  },
  // Ekran efekti — kar modunun genellenmişi (none | snow | confetti | hearts | leaves)
  effect: { type: "none", intensity: 60, speed: 1, size: 1 },
  // Premium olmayan kullanıcılara review banner kampanyası.
  // ⚠️ Bu banner premium VERMEZ — sadece App Store değerlendirme penceresini açar.
  reviewPromoBanner: {
    enabled: false,
    premiumDays: 0,
    translations: {
      en: "Enjoying the app? Rate us 5 stars!",
      tr: "Uygulamayı beğendin mi? 5 yıldız ver!",
      de: "",
      es: "",
      fr: "",
      it: "",
      nl: "",
      ja: "",
      "pt-BR": "",
      ru: "",
      hi: ""
    }
  }
};

// ── Kullanıcı girişi ─────────────────────────────────────────
// Kullanıcılar Railway'de ADMIN_USERS env değişkeninde JSON olarak tutulur
// (şifreler koda yazılmaz — repo herkese açık!). Örnek:
// [{"username":"Nisa","password":"Nisa123","displayName":"Nisa","title":"Kurucu"}]
function loadAdminUsers() {
  try {
    const parsed = JSON.parse(process.env.ADMIN_USERS || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("ADMIN_USERS geçerli JSON değil — kullanıcı girişi devre dışı");
    return [];
  }
}
const adminUsers = loadAdminUsers();

// ── Kalıcı oturum (HMAC imzalı token) ────────────────────────
// Oturumlar artık bellekte değil — token'ın kendisi imzalı olduğu için
// sunucu yeniden başlasa / redeploy olsa bile oturum 30 gün geçerli kalır.
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN;
const SESSION_TTL_MS = 30 * 86400e3;

function signSession(profile) {
  const payload = Buffer.from(JSON.stringify({
    username: profile.username,
    displayName: profile.displayName,
    title: profile.title,
    exp: Date.now() + SESSION_TTL_MS
  })).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.lastIndexOf(".");
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    return { username: data.username, displayName: data.displayName, title: data.title };
  } catch {
    return null;
  }
}

async function githubRequest(path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      "authorization": `Bearer ${GITHUB_TOKEN}`,
      "accept": "application/vnd.github+json",
      "user-agent": "islandly-wallpaper-server",
      ...(options.headers || {})
    }
  });
}

/** Açılışta GitHub'daki güncel dosyayı lokale indirir. */
async function pullFileFromGitHub(repoPath, localFile) {
  if (!GITHUB_TOKEN) return;
  try {
    const res = await githubRequest(
      `/repos/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`
    );
    if (!res.ok) return;
    const json = await res.json();
    const content = Buffer.from(json.content, "base64").toString("utf8");
    JSON.parse(content); // geçerli JSON değilse dokunma
    await writeFile(localFile, content, "utf8");
    console.log(`✓ ${repoPath} pulled from GitHub`);
  } catch (error) {
    console.warn("GitHub pull failed:", error.message);
  }
}

/** Her değişiklikte dosyayı GitHub'a commit'ler ([skip railway] → redeploy tetiklemez). */
async function pushFileToGitHub(repoPath, data, message) {
  if (!GITHUB_TOKEN) return;
  try {
    const get = await githubRequest(
      `/repos/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`
    );
    const sha = get.ok ? (await get.json()).sha : undefined;
    const content = Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString("base64");
    const res = await githubRequest(`/repos/${GITHUB_REPO}/contents/${repoPath}`, {
      method: "PUT",
      body: JSON.stringify({ message, content, sha, branch: GITHUB_BRANCH })
    });
    if (res.ok) console.log(`✓ ${repoPath} pushed to GitHub`);
    else console.warn("GitHub push failed:", res.status, await res.text());
  } catch (error) {
    console.warn("GitHub push failed:", error.message);
  }
}

// ── RevenueCat (gelir metrikleri) ────────────────────────────
// Railway'de tanımlanacak env değişkenleri:
//   REVENUECAT_V2_KEY     → RevenueCat → Project settings → API keys → + New,
//                           Version: V2, izin: charts_metrics:overview:read
//                           ("sk_" ile başlar — GİZLİ, app'teki appl_ anahtarı DEĞİL)
//   REVENUECAT_PROJECT_ID → RevenueCat → Project settings → General → Project ID
//                           ("proj" ile başlar)
const REVENUECAT_V2_KEY = process.env.REVENUECAT_V2_KEY || "";
const REVENUECAT_PROJECT_ID = process.env.REVENUECAT_PROJECT_ID || "";
const REVENUECAT_CURRENCY = process.env.REVENUECAT_CURRENCY || "USD";

// RevenueCat'in "Charts & Metrics" limiti dakikada 25 istek. Panel her açılışta
// çağırdığı için 5 dakikalık önbellek tutuyoruz — limite hiç yaklaşmayız.
const RC_CACHE_TTL_MS = 5 * 60_000;
let rcCache = { data: null, at: 0 };

async function fetchRevenueCatOverview({ force = false } = {}) {
  if (!REVENUECAT_V2_KEY || !REVENUECAT_PROJECT_ID) {
    const missing = [
      !REVENUECAT_V2_KEY && "REVENUECAT_V2_KEY",
      !REVENUECAT_PROJECT_ID && "REVENUECAT_PROJECT_ID"
    ].filter(Boolean);
    const error = new Error(`${missing.join(" ve ")} tanımlı değil`);
    error.statusCode = 501;
    throw error;
  }

  if (!force && rcCache.data && Date.now() - rcCache.at < RC_CACHE_TTL_MS) {
    return { ...rcCache.data, cached: true, fetchedAt: new Date(rcCache.at).toISOString() };
  }

  const url = new URL(
    `https://api.revenuecat.com/v2/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}/metrics/overview`
  );
  url.searchParams.set("currency", REVENUECAT_CURRENCY);

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${REVENUECAT_V2_KEY}`,
      accept: "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text();
    // Sık yapılan hataları anlaşılır mesaja çevir
    let hint = "";
    if (res.status === 401) hint = " — anahtar geçersiz. V2 secret key (sk_…) kullandığından emin ol, app'teki appl_… anahtarı çalışmaz.";
    else if (res.status === 403) hint = " — anahtarda 'charts_metrics:overview:read' izni yok.";
    else if (res.status === 404) hint = " — REVENUECAT_PROJECT_ID hatalı görünüyor.";
    else if (res.status === 429) hint = " — dakikalık istek limiti aşıldı, birazdan tekrar dene.";
    const error = new Error(`RevenueCat ${res.status}${hint} ${body.slice(0, 200)}`.trim());
    error.statusCode = res.status === 429 ? 429 : 502;
    throw error;
  }

  const json = await res.json();
  // ⚠️ metrics[].id değerleri RevenueCat dokümanında listelenmiyor. Bu yüzden
  // sabit bir id listesine güvenmiyoruz — panel diziyi olduğu gibi render eder.
  const data = {
    currency: json.currency || REVENUECAT_CURRENCY,
    metrics: Array.isArray(json.metrics) ? json.metrics : []
  };
  rcCache = { data, at: Date.now() };
  return { ...data, cached: false, fetchedAt: new Date().toISOString() };
}

// ── Firebase (kullanıcı listesi + login takibi) ──────────────
// Railway'de FIREBASE_SERVICE_ACCOUNT env değişkenine Firebase Console →
// Project settings → Service accounts → "Generate new private key" ile inen
// JSON'un TAMAMI yapıştırılır. Service account Firestore kurallarını bypass
// eder — kurallar kilitli kalabilir (güvenli), yazma sunucudan yapılır.
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || "";

// Firestore ve FCM farklı OAuth kapsamları ister — her kapsam için ayrı token cache
const SCOPE_FIRESTORE = "https://www.googleapis.com/auth/datastore";
const SCOPE_MESSAGING = "https://www.googleapis.com/auth/firebase.messaging";
const fbTokenCaches = new Map(); // scope -> { token, exp }

function firebaseServiceAccount() {
  if (!FIREBASE_SERVICE_ACCOUNT) return null;
  try { return JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch { return null; }
}

async function firebaseAccessToken(scope = SCOPE_FIRESTORE) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil veya geçersiz JSON");

  const cached = fbTokenCaches.get(scope);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;

  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Google token alınamadı: ${await res.text()}`);
  const json = await res.json();
  fbTokenCaches.set(scope, { token: json.access_token, exp: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

// ── Push bildirimi (FCM HTTP v1) ─────────────────────────────
// Ek kuruluma gerek yok: mevcut FIREBASE_SERVICE_ACCOUNT kullanılır,
// sadece OAuth kapsamı farklı (firebase.messaging).
//
// ⚠️ FCM v1'de çoklu gönderim (batch) uç noktası KAPATILDI (21.06.2024).
// Her cihaza ayrı HTTP isteği gitmek zorunda — bu yüzden sınırlı
// eşzamanlılıkla döngü kuruyoruz.

const FCM_CONCURRENCY = 20;
const PUSH_LOCALES = ["en", "tr", "de", "es", "fr", "it", "nl", "ja", "pt-BR", "ru", "hi"];

function normalizePushLocale(input) {
  const raw = String(input || "").trim();
  if (!raw) return "en";

  const lower = raw.toLowerCase();
  if (lower === "pt" || lower === "pt-br" || lower.startsWith("pt-")) return "pt-BR";

  const exact = PUSH_LOCALES.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;

  const base = lower.split(/[-_]/)[0];
  const baseMatch = PUSH_LOCALES.find((code) => code.toLowerCase() === base);
  return baseMatch || "en";
}

function sanitizeTranslationMap(input, maxLen) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const locale = normalizePushLocale(key);
    const clean = String(value || "").trim().slice(0, maxLen);
    if (clean) out[locale] = clean;
  }
  return out;
}

function pickLocalizedPushText(map, locale, fallback) {
  const safeFallback = String(fallback || "").trim();
  if (!map || typeof map !== "object") return safeFallback;

  const normalized = normalizePushLocale(locale);
  return map[normalized] || map.en || safeFallback;
}

/** Tek cihaza bildirim gönderir. Dönen kod token silinmeli mi belirtir. */
async function sendPushToToken(accessToken, projectID, token, { title, body, deepLink }) {
  const message = {
    token,
    notification: { title, body },
    apns: {
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: {
        // aps.alert'i açıkça yazıyoruz: apns.payload varken FCM'in generic
        // notification alanlarını ezme ihtimali dokümanda muğlak bırakılmış.
        aps: { alert: { title, body }, sound: "default" }
      }
    }
  };
  if (deepLink) message.data = { deepLink: String(deepLink) };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectID)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message })
    }
  );

  if (res.ok) return { ok: true };

  const json = await res.json().catch(() => ({}));
  const err = json.error || {};
  // FCM'e özgü hata kodu details[] içinde FcmError tipinde gelir;
  // yoksa error.status'a düşülür (Firebase Admin SDK'nın yaptığı gibi).
  const fcmDetail = (err.details || []).find(
    (d) => String(d["@type"] || "").endsWith("google.firebase.fcm.v1.FcmError")
  );
  const code = fcmDetail?.errorCode || err.status || `HTTP_${res.status}`;

  // UNREGISTERED → token kesin ölü.
  // INVALID_ARGUMENT → SADECE FcmError tipindeyse token bozuk demektir;
  // BadRequest tipindeyse bizim payload'ımız hatalıdır, token'a dokunma.
  const dead =
    code === "UNREGISTERED" ||
    code === "UNREGISTERED_FID" ||
    (code === "INVALID_ARGUMENT" && !!fcmDetail);

  return { ok: false, code, dead, message: err.message || "" };
}

/** Kullanıcı belgesinden fcmToken alanını siler (ölü token temizliği). */
async function deleteFcmToken(accessToken, projectID, userID) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectID}/databases/(default)/documents`;
  await fetch(
    `${base}/users/${encodeURIComponent(userID)}?updateMask.fieldPaths=fcmToken`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: {} })
    }
  ).catch(() => {});
}

/**
 * Segmentteki tüm kullanıcılara push gönderir.
 * target: all | premium | nonpremium
 */
async function sendPushCampaign({ title, body, target = "all", deepLink = "", titleTranslations = {}, bodyTranslations = {} }) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");

  const cleanTitle = String(title || "").trim().slice(0, 120);
  const cleanBody = String(body || "").trim().slice(0, 400);
  if (!cleanTitle || !cleanBody) throw new Error("Başlık ve mesaj zorunlu");
  const cleanTitleTranslations = sanitizeTranslationMap(titleTranslations, 120);
  const cleanBodyTranslations = sanitizeTranslationMap(bodyTranslations, 400);

  const users = await fetchFirebaseUsers();
  const now = new Date();
  const isPremium = (u) => {
    const sub = u.subscription;
    if (!sub || sub.isActive !== true) return false;
    const pid = String(sub.productID || "");
    if (REVOKED_PRODUCT_PREFIXES.some((p) => pid.startsWith(p))) return false;
    const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
    return !exp || exp > now;
  };

  const targets = users.filter((u) => {
    if (!u.fcmToken || typeof u.fcmToken !== "string") return false;
    if (target === "premium") return isPremium(u);
    if (target === "nonpremium") return !isPremium(u);
    return true;
  });

  if (!targets.length) {
    return { sent: 0, failed: 0, removed: 0, total: 0, target, noTokens: true };
  }

  const messagingToken = await firebaseAccessToken(SCOPE_MESSAGING);
  const firestoreToken = await firebaseAccessToken(SCOPE_FIRESTORE);

  let sent = 0, failed = 0, removed = 0;
  const errorCounts = {};
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const user = targets[cursor++];
      try {
        const locale = normalizePushLocale(user.fcmLocale || user.languageCode || user.locale || "en");
        const localizedTitle = pickLocalizedPushText(cleanTitleTranslations, locale, cleanTitle);
        const localizedBody = pickLocalizedPushText(cleanBodyTranslations, locale, cleanBody);
        const r = await sendPushToToken(messagingToken, sa.project_id, user.fcmToken, {
          title: localizedTitle, body: localizedBody, deepLink
        });
        if (r.ok) { sent += 1; continue; }
        failed += 1;
        errorCounts[r.code] = (errorCounts[r.code] || 0) + 1;
        if (r.dead) {
          await deleteFcmToken(firestoreToken, sa.project_id, user.docID);
          removed += 1;
        }
      } catch (error) {
        failed += 1;
        errorCounts.NETWORK = (errorCounts.NETWORK || 0) + 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FCM_CONCURRENCY, targets.length) }, worker)
  );

  const record = {
    id: randomUUID(),
    title: cleanTitle,
    body: cleanBody,
    titleTranslations: cleanTitleTranslations,
    bodyTranslations: cleanBodyTranslations,
    target,
    deepLink,
    total: targets.length,
    sent, failed, removed,
    errors: errorCounts,
    sentAt: new Date().toISOString()
  };
  const history = await readPushHistory();
  history.unshift(record);
  await writePushHistory(history.slice(0, 100));

  return record;
}

/** Firestore'un tipli değerlerini sade JS değerine çevirir. */
function parseFsValue(v) {
  if (v == null || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = parseFsValue(val);
    return out;
  }
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(parseFsValue);
  return null;
}

/** users koleksiyonunun tamamını çeker (sayfalı). */
async function fetchFirebaseUsers() {
  const sa = firebaseServiceAccount();
  const token = await firebaseAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const users = [];
  let pageToken = "";
  do {
    const u = new URL(`${base}/users`);
    u.searchParams.set("pageSize", "300");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore okunamadı: ${await res.text()}`);
    const json = await res.json();
    for (const doc of json.documents || []) {
      const fields = {};
      for (const [k, v] of Object.entries(doc.fields || {})) fields[k] = parseFsValue(v);
      users.push({ docID: doc.name.split("/").pop(), ...fields });
    }
    pageToken = json.nextPageToken || "";
  } while (pageToken && users.length < 5000);
  return users;
}

/** Login kaydını Firestore'a yazar (merge) — iOS app her girişte çağırır. */
async function trackFirebaseUser(input) {
  const id = String(input.id || "").trim();
  // Sadece gerçek Apple/Google kimlik formatları — HTML/script enjeksiyonunu
  // ve çöp kayıtları en baştan engelle
  if (!/^[A-Za-z0-9._:@-]{4,160}$/.test(id)) throw new Error("invalid id");
  const sa = firebaseServiceAccount();
  const token = await firebaseAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const docPath = `${base}/users/${encodeURIComponent(id)}`;
  const nowISO = new Date().toISOString();

  // createdAt sadece ilk kayıtta yazılır
  const existing = await fetch(docPath, { headers: { authorization: `Bearer ${token}` } });
  const isNew = existing.status === 404;

  // < > ve kontrol karakterleri temizlenir — panelde XSS'e karşı 2. savunma hattı
  const clean = (value, max) => String(value || "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);

  const fields = {
    id: { stringValue: id },
    displayName: { stringValue: clean(input.displayName, 120) },
    email: { stringValue: clean(input.email, 200) },
    provider: { stringValue: clean(input.provider, 30) },
    lastLoginAt: { timestampValue: nowISO }
  };
  if (isNew) fields.createdAt = { timestampValue: nowISO };

  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const res = await fetch(`${docPath}?${mask}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`Firestore yazılamadı: ${await res.text()}`);
  return { isNew };
}

// ── RevenueCat → Firestore abonelik senkronu ─────────────────
//
// SORUN: App Store'dan gerçekten satın alanların aboneliği Firestore'a hiç
// yazılmıyordu. iOS'un yazması güvenlik kurallarıyla kapalı, sunucu ise
// yalnızca hediye verirken yazıyordu. Sonuç: panelin premium listesi sadece
// hediye alanları gösteriyordu, gerçek aboneler görünmüyordu.
//
// ÇÖZÜM: RevenueCat zaten her satın almayı biliyor (observer mode) ve
// Purchases.logIn(user.id) sayesinde app_user_id = Firestore belge kimliği.
// 1) Webhook  → anlık olaylar (satın alma, yenileme, süre bitişi, iade)
// 2) Senkron  → mevcut abonelerin kaydını tek seferde doldurur

/** Panelde "APP STORE" rozeti çıkması için productID bu önekle yazılır. */
const APPSTORE_PRODUCT_PREFIX = "com.dynamicisland.premium";

/** Webhook'ta RevenueCat'in göndereceği Authorization başlığı. */
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || "";

/** SANDBOX (TestFlight/simülatör) satın almaları paneli kirletmesin. */
const REVENUECAT_ALLOW_SANDBOX = process.env.REVENUECAT_ALLOW_SANDBOX === "1";

/**
 * Firestore'daki `subscription` alanını RevenueCat verisiyle yazar.
 *
 * Kullanıcı tercihi: gerçek abonelik hediyenin ÜZERİNE yazar. Yani panelden
 * hediye verilmiş bir kullanıcı sonra abone olursa kayıt App Store aboneliğine
 * döner. (Not: hediyenin kalan günleri bu durumda kaybolur.)
 */
async function writeSubscriptionOnServer(userID, { productID, expiresAt, isActive, planType }) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const docPath = `https://firestore.googleapis.com/v1/projects/${sa.project_id}` +
    `/databases/(default)/documents/users/${encodeURIComponent(userID)}`;

  const fields = {
    productID: { stringValue: String(productID || APPSTORE_PRODUCT_PREFIX) },
    planType: { stringValue: planType || "PREMİUM - ÜCRETLİ" },
    updatedAt: { timestampValue: new Date().toISOString() },
    isActive: { booleanValue: !!isActive },
    // Kaynağı işaretle — ileride hediye/abonelik ayrımı gerekirse elde dursun
    source: { stringValue: "revenuecat" }
  };
  fields.expiresAt = expiresAt
    ? { timestampValue: new Date(expiresAt).toISOString() }
    : { nullValue: null };

  const res = await fetch(`${docPath}?updateMask.fieldPaths=subscription`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: { subscription: { mapValue: { fields } } } })
  });
  if (!res.ok) throw new Error(`Abonelik yazılamadı: ${await res.text()}`);
  return { userID, isActive: !!isActive, expiresAt: expiresAt || null };
}

/**
 * Webhook olayını işler.
 *
 * Erişim VERİLEN olaylar: satın alma, yenileme, iptalin geri alınması,
 * ürün değişikliği, süre uzatma, iade iptali, geçici erişim.
 *
 * ⚠️ CANCELLATION erişimi KALDIRMAZ — RevenueCat'te "iptal" otomatik
 * yenilemenin kapatılması demek, kullanıcı dönem sonuna kadar premium kalır.
 * Erişim yalnızca EXPIRATION ile kaldırılır. BILLING_ISSUE ve
 * SUBSCRIPTION_PAUSED de erişimi kaldırmaz (doküman böyle diyor).
 */
const RC_GRANT_EVENTS = new Set([
  "INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE",
  "SUBSCRIPTION_EXTENDED", "NON_RENEWING_PURCHASE", "REFUND_REVERSED",
  "TEMPORARY_ENTITLEMENT_GRANT"
]);
const RC_REVOKE_EVENTS = new Set(["EXPIRATION"]);

async function handleRevenueCatEvent(event) {
  const type = String(event?.type || "");

  // TEST olayı: panelden "Send test event" denince gelir, veriye dokunma
  if (type === "TEST") return { skipped: "test event" };

  // Sandbox satın almaları gerçek kullanıcı sayılmasın
  if (!REVENUECAT_ALLOW_SANDBOX && event?.environment === "SANDBOX") {
    return { skipped: "sandbox" };
  }

  // TRANSFER: abonelik başka bir app_user_id'ye taşınmış
  if (type === "TRANSFER") {
    const results = [];
    for (const from of event.transferred_from || []) {
      results.push(await writeSubscriptionOnServer(from, { isActive: false, expiresAt: null }));
    }
    // Hedef kullanıcının gerçek durumu bir sonraki olayla/senkronla düzelir
    return { transferred: results.length };
  }

  const grant = RC_GRANT_EVENTS.has(type);
  const revoke = RC_REVOKE_EVENTS.has(type);
  if (!grant && !revoke) return { skipped: `ilgisiz olay: ${type}` };

  // Kullanıcıyı bulurken alias'lara da bak (doküman öneriyor)
  const userID = event.app_user_id || event.original_app_user_id;
  if (!userID) return { skipped: "app_user_id yok" };

  const expiresAt = event.expiration_at_ms ? new Date(Number(event.expiration_at_ms)) : null;

  // Süre bitişi geleceğe dönükse (nadiren olur) erişimi kaldırma
  if (revoke && expiresAt && expiresAt > new Date()) {
    return { skipped: "expiration ama tarih ileride" };
  }

  return await writeSubscriptionOnServer(userID, {
    productID: event.product_id || APPSTORE_PRODUCT_PREFIX,
    expiresAt: grant ? expiresAt : expiresAt,
    isActive: grant,
    planType: event.period_type === "TRIAL" ? "PREMİUM - DENEME" : "PREMİUM - ÜCRETLİ"
  });
}

/**
 * Tek bir kullanıcının RevenueCat'teki aboneliklerini okur.
 * V2: GET /v2/projects/{id}/customers/{app_user_id}/subscriptions
 *
 * Not: kullanılan V2 anahtarında `customer_information:subscriptions:read`
 * izni açık olmalı — gelir grafiği için verilen `charts_metrics` izni yetmez.
 */
async function fetchRevenueCatSubscriptions(appUserID) {
  const url = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}` +
    `/customers/${encodeURIComponent(appUserID)}/subscriptions`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${REVENUECAT_V2_KEY}`, accept: "application/json" }
  });
  if (res.status === 404) return [];           // RevenueCat'te böyle müşteri yok
  if (!res.ok) throw new Error(`RevenueCat ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * `items` dizisinden "şu an premium mi" sonucunu çıkarır.
 *
 * Durum (`status`) isimlerine güvenmek yerine bitiş tarihine bakıyoruz:
 * iptal edilmiş ama süresi dolmamış abonelik hâlâ premiumdur. Yalnızca
 * açıkça sonlanmış (expired/refund) kayıtlar elenir. Sıralama garantisi
 * olmadığı için en ileri tarih seçilir.
 */
function resolveActiveSubscription(items) {
  let best = null;
  for (const it of items) {
    const status = String(it.status || "").toLowerCase();
    if (status.includes("expired") || status.includes("refund")) continue;
    const raw = it.current_period_ends_at ?? it.expires_at ?? null;
    const ends = raw == null ? null : new Date(Number(raw) || raw);
    if (ends && !(ends > new Date())) continue;
    if (!best || (ends && best.ends && ends > best.ends) || (ends && !best.ends)) {
      best = { ends, productID: it.product_id || null, status };
    }
  }
  return best;
}

/**
 * Mevcut kullanıcıları RevenueCat ile karşılaştırıp Firestore'u doldurur.
 * Webhook yalnızca bundan SONRAKİ olayları yakalar; bu fonksiyon geçmişi kapatır.
 *
 * RevenueCat'in istek limitine takılmamak için aynı anda 5 kullanıcı sorgulanır.
 */
async function syncSubscriptionsFromRevenueCat({ limit = 2000 } = {}) {
  if (!REVENUECAT_V2_KEY || !REVENUECAT_PROJECT_ID) {
    const e = new Error("REVENUECAT_V2_KEY ve REVENUECAT_PROJECT_ID gerekli");
    e.statusCode = 501;
    throw e;
  }
  const users = (await fetchFirebaseUsers()).slice(0, limit);
  const summary = { checked: 0, activated: 0, deactivated: 0, unchanged: 0, errors: [] };

  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < users.length) {
      const u = users[cursor++];
      const id = u.docID;
      summary.checked++;
      try {
        const active = resolveActiveSubscription(await fetchRevenueCatSubscriptions(id));
        const wasActive = u.subscription?.isActive === true;
        const isGift = String(u.subscription?.productID || "").startsWith("gift.");

        if (active) {
          await writeSubscriptionOnServer(id, {
            productID: active.productID || APPSTORE_PRODUCT_PREFIX,
            expiresAt: active.ends,
            isActive: true
          });
          summary.activated++;
        } else if (wasActive && !isGift) {
          // RevenueCat'e göre aktif değil — hediyeler korunur, App Store kayıtları kapanır
          await writeSubscriptionOnServer(id, {
            productID: u.subscription?.productID || APPSTORE_PRODUCT_PREFIX,
            expiresAt: u.subscription?.expiresAt || null,
            isActive: false
          });
          summary.deactivated++;
        } else {
          summary.unchanged++;
        }
      } catch (error) {
        if (summary.errors.length < 10) summary.errors.push(`${id}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return summary;
}

/**
 * Kullanıcıyı admin panelinden gizler/geri getirir.
 *
 * ÖNEMLİ: kullanıcının uygulama deneyimine HİÇBİR etkisi yok — premium,
 * abonelik, hediyeler, kayıt tarihi hepsi yerinde kalır. Sadece panelin
 * Kullanıcılar listesinde görünmez olur.
 *
 * Kayıt silinmediği için `/api/users/track` bir sonraki girişte belgeyi
 * yeniden oluşturmaz; üstelik track updateMask'i `hiddenInAdmin` alanına
 * dokunmadığından gizleme kullanıcı tekrar giriş yapsa da bozulmaz.
 */
async function setUserHiddenOnServer(userID, hidden) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const docPath = `https://firestore.googleapis.com/v1/projects/${sa.project_id}` +
    `/databases/(default)/documents/users/${encodeURIComponent(userID)}`;

  // Yalnızca hiddenInAdmin alanına yazar — diğer alanlar korunur
  const res = await fetch(`${docPath}?updateMask.fieldPaths=hiddenInAdmin`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: { hiddenInAdmin: { booleanValue: !!hidden } } })
  });
  if (!res.ok) throw new Error(`Gizleme yazılamadı: ${await res.text()}`);
  return { userID, hidden: !!hidden };
}

/**
 * Kullanıcı belgesini Firestore'dan KALICI siler.
 *
 * Dikkat: premium/hediye geçmişi ve kayıt tarihi de gider. Kullanıcı
 * uygulamayı bir sonraki açışında `/api/users/track` belgeyi sıfırdan
 * oluşturur — yani panelde yeni kullanıcı gibi tekrar belirir.
 * Kalıcı olarak listeden çıkarmak için silmek değil GİZLEMEK gerekir.
 */
async function deleteUserOnServer(userID) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const docPath = `https://firestore.googleapis.com/v1/projects/${sa.project_id}` +
    `/databases/(default)/documents/users/${encodeURIComponent(userID)}`;

  const res = await fetch(docPath, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
  // 404 = zaten yok, bunu hata sayma
  if (!res.ok && res.status !== 404) throw new Error(`Silinemedi: ${await res.text()}`);
  return { userID, deleted: true };
}

/**
 * Kullanıcıya premium yazar (hediye). Service account ile yazıldığı için
 * Firestore güvenlik kuralları kilitli olsa bile ÇALIŞIR — cihazdan yazma
 * kurallara takılıyordu, premium hediyelerin aktifleşmeme sebebi buydu.
 * Mevcut abonelik daha ileri bir tarihteyse üzerine yazmaz, gün ekler.
 */
async function grantPremiumOnServer(userID, days) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const docPath = `${base}/users/${encodeURIComponent(userID)}`;

  // Mevcut bitiş tarihini oku — aktifse üzerine ekle
  let start = new Date();
  try {
    const res = await fetch(docPath, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const doc = await res.json();
      const sub = doc.fields?.subscription?.mapValue?.fields;
      const current = sub?.expiresAt?.timestampValue;
      if (current && new Date(current) > start) start = new Date(current);
    }
  } catch { /* okunamazsa şimdiden başlat */ }

  const expiresAt = new Date(start.getTime() + days * 86400e3);
  const fields = {
    subscription: {
      mapValue: {
        fields: {
          productID: { stringValue: `gift.${days}days` },
          planType: { stringValue: "PREMİUM - HEDİYE" },
          expiresAt: { timestampValue: expiresAt.toISOString() },
          updatedAt: { timestampValue: new Date().toISOString() },
          isActive: { booleanValue: true }
        }
      }
    }
  };

  const res = await fetch(`${docPath}?updateMask.fieldPaths=subscription`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`Premium yazılamadı: ${await res.text()}`);
  return { expiresAt: expiresAt.toISOString() };
}

/**
 * Kullanıcının abonelik durumunu döner — iOS Firestore'u okuyamazsa buraya sorar.
 *
 * ⚠️ Otomatik "hoşgeldin hediyesi" (productID = welcome.*) ARTIK GEÇERSİZ sayılır.
 * Eskiden uygulama her yeni girişte Firestore'a welcome.3days yazıyordu ve
 * burası onu "aktif abonelik" diye döndüğü için indiren herkes premium oluyordu.
 * Sadece panelden gönderilen manuel hediyeler (gift.*) geçerli kalır;
 * App Store abonelikleri zaten StoreKit/RevenueCat üzerinden doğrulanır.
 */
const REVOKED_PRODUCT_PREFIXES = ["welcome."];

async function readSubscriptionOnServer(userID) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const res = await fetch(`${base}/users/${encodeURIComponent(userID)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) return { isActive: false, expiresAt: null, productID: null };
  const doc = await res.json();
  const sub = doc.fields?.subscription?.mapValue?.fields;
  if (!sub) return { isActive: false, expiresAt: null, productID: null };

  const productID = sub.productID?.stringValue || "";
  const expiresAt = sub.expiresAt?.timestampValue || null;
  const flag = sub.isActive?.booleanValue === true;
  const notExpired = !expiresAt || new Date(expiresAt) > new Date();
  const revoked = REVOKED_PRODUCT_PREFIXES.some((p) => productID.startsWith(p));

  return { isActive: flag && notExpired && !revoked, expiresAt, productID };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // public/media/ — canlı duvar kağıdı dosyaları
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".png": "image/png",
  ".webp": "image/webp"
};

/// Medya dosyaları isimleriyle sabit — uzun süre önbelleklensin.
const MEDIA_EXTENSIONS = new Set([".mov", ".mp4", ".jpg", ".jpeg", ".gif", ".png", ".webp"]);

/// Widget vitrini için medya dosyaları. İçerikler public/media/widgets
/// klasörüne eklenir; uygulamaya yeni sürüm göndermeden bu uç noktadan görünür.
async function readWidgets() {
  const directory = join(PUBLIC_DIR, "media", "widgets");
  try {
    const files = (await readdir(directory))
      .filter((file) => [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extname(file).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

    return files.map((file, index) => ({
      id: `widget-${String(index + 1).padStart(3, "0")}`,
      imageURL: `/media/widgets/${encodeURIComponent(file)}`,
      type: extname(file).toLowerCase() === ".gif" ? "animated" : "image",
      order: index + 1
    }));
  } catch {
    return [];
  }
}

async function readWallpapers() {
  const raw = await readFile(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeWallpapers(items) {
  await writeFile(DATA_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  pushFileToGitHub(GITHUB_DATA_PATH, items,
    "chore: update wallpapers via admin panel [skip railway]"); // arka planda
}

async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      snow: { ...DEFAULT_CONFIG.snow, ...(raw.snow || {}) },
      announcement: { ...DEFAULT_CONFIG.announcement, ...(raw.announcement || {}) },
      wallpapers: { ...DEFAULT_CONFIG.wallpapers, ...(raw.wallpapers || {}) },
      themes: { ...DEFAULT_CONFIG.themes, ...(raw.themes || {}) },
      paywall: { ...DEFAULT_CONFIG.paywall, ...(raw.paywall || {}) },
      effect: { ...DEFAULT_CONFIG.effect, ...(raw.effect || {}) },
      reviewPromoBanner: {
        ...DEFAULT_CONFIG.reviewPromoBanner,
        ...(raw.reviewPromoBanner || {}),
        translations: { ...DEFAULT_CONFIG.reviewPromoBanner.translations, ...(raw.reviewPromoBanner?.translations || {}) }
      }
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config) {
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  pushFileToGitHub(GITHUB_CONFIG_PATH, config,
    "chore: update app config via admin panel [skip railway]"); // arka planda
}

// ── Hediyeler (kullanıcı ID'sine premium / coin / pet gönderme) ──
// Panel hediye oluşturur → iOS app açılışta kendi ID'siyle bekleyenleri
// çeker, uygular ve claim eder.
async function readGifts() {
  try {
    return JSON.parse(await readFile(GIFTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function writeGifts(items) {
  await writeFile(GIFTS_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  pushFileToGitHub(GITHUB_GIFTS_PATH, items,
    "chore: update gifts via admin panel [skip railway]"); // arka planda
}

// ── Push gönderim geçmişi ────────────────────────────────────
// Son 100 kampanya tutulur — panelde "ne göndermiştim" listesi.

async function readPushHistory() {
  try {
    const parsed = JSON.parse(await readFile(PUSH_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writePushHistory(items) {
  await writeFile(PUSH_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  pushFileToGitHub(GITHUB_PUSH_PATH, items,
    "chore: update push history via admin panel [skip railway]");
}

// ── Dönüşüm olayları (paywall istatistikleri) ────────────────
// Ham olay değil GÜNLÜK SAYAÇ tutulur — dosya küçük kalır:
// { "2026-08-03": { "paywallShown": 12, "purchases": { "com...monthly": 2 } } }
const EVENT_TYPES = new Set(["paywall_shown", "purchase"]);

async function readEvents() {
  try {
    return JSON.parse(await readFile(EVENTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

let eventsWriteTimer = null;
async function writeEvents(events) {
  await writeFile(EVENTS_FILE, `${JSON.stringify(events, null, 2)}\n`, "utf8");
  // GitHub push'u 60 sn'de bire sınırla — her olayda commit atılmasın
  if (!eventsWriteTimer) {
    eventsWriteTimer = setTimeout(() => {
      eventsWriteTimer = null;
      readEvents().then((latest) =>
        pushFileToGitHub(GITHUB_EVENTS_PATH, latest,
          "chore: update events via app [skip railway]"));
    }, 60_000);
  }
}

async function recordEvent(input) {
  const type = String(input.type || "").trim();
  if (!EVENT_TYPES.has(type)) throw new Error("type must be paywall_shown or purchase");

  const events = await readEvents();
  const day = new Date().toISOString().slice(0, 10);
  const bucket = events[day] || (events[day] = { paywallShown: 0, purchases: {} });

  if (type === "paywall_shown") {
    bucket.paywallShown += 1;
  } else {
    // Ürün ID'si panelde gösterilir — sadece güvenli karakterler
    const pid = String(input.productID || "unknown")
      .replace(/[^A-Za-z0-9._-]/g, "").slice(0, 120) || "unknown";
    bucket.purchases[pid] = (bucket.purchases[pid] || 0) + 1;
  }

  // 120 günden eski günleri temizle
  const cutoff = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
  for (const key of Object.keys(events)) {
    if (key < cutoff) delete events[key];
  }

  await writeEvents(events);
}

const GIFT_KINDS = new Set(["premium", "coins", "pet"]);

/** Panelden gelen hediye girdisini doğrular ve normalize eder. */
function normalizeGift(input) {
  const userID = String(input.userID || "").trim();
  const kind = String(input.kind || "").trim();

  if (!userID) throw new Error("userID is required");
  if (!GIFT_KINDS.has(kind)) throw new Error("kind must be premium, coins or pet");

  const gift = {
    id: randomUUID(),
    userID,
    kind,
    note: String(input.note || "").slice(0, 200),
    createdAt: new Date().toISOString(),
    claimed: false,
    claimedAt: null
  };

  if (kind === "premium") {
    const days = Number(input.premiumDays);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new Error("premiumDays must be between 1 and 3650");
    }
    gift.premiumDays = Math.floor(days);
  } else if (kind === "coins") {
    const amount = Number(input.coins);
    if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) {
      throw new Error("coins must be between 1 and 1000000");
    }
    gift.coins = Math.floor(amount);
  } else if (kind === "pet") {
    const petType = String(input.petType || "").trim();
    if (!petType) throw new Error("petType is required");
    gift.petType = petType;
  }

  return gift;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-token,x-admin-session",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    ...headers
  });
  res.end(payload);
}

function sendJSONFresh(res, status, body, headers = {}) {
  send(res, status, body, {
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "pragma": "no-cache",
    "expires": "0",
    ...headers
  });
}

async function parseBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error("Body too large"); // 1MB sınır — DoS koruması
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── Hız sınırı (IP başına) ───────────────────────────────────
// Public uçlara spam / brute-force koruması. Bellek içi — Railway tek instance.
const rateBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 60_000).unref();

function clientIP(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "?";
}

function rateLimit(req, res, name, max, windowMs) {
  const key = `${name}:${clientIP(req)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    send(res, 429, { error: "Çok fazla istek — biraz bekle" },
      { "retry-after": String(Math.ceil((bucket.resetAt - now) / 1000)) });
    return false;
  }
  return true;
}

/** Zamanlama saldırısına dayanıklı karşılaştırma. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAdminRequest(req) {
  const session = req.headers["x-admin-session"];
  if (session && verifySession(session)) return true;
  return !!(req.headers["x-admin-token"] && safeEqual(req.headers["x-admin-token"], ADMIN_TOKEN));
}

function requireAdmin(req, res) {
  // 1) Kullanıcı oturumu (imzalı token) 2) Eski usül admin token — ikisi de geçerli
  if (isAdminRequest(req)) return true;
  send(res, 401, { error: "Unauthorized" });
  return false;
}

function normalizeIsoOrEmpty(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function timestampOrNull(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function wallpaperLifecycle(wallpaper, now = Date.now()) {
  const status = String(wallpaper.status || "published");
  const publishAtMs = timestampOrNull(wallpaper.publishAt);
  const unpublishAtMs = timestampOrNull(wallpaper.unpublishAt);

  if (status === "draft") {
    return { state: publishAtMs && publishAtMs > now ? "scheduled" : "draft", visible: false };
  }
  if (status === "hidden") return { state: "hidden", visible: false };
  if (status === "archived") return { state: "archived", visible: false };
  if (publishAtMs && publishAtMs > now) return { state: "scheduled", visible: false };
  if (unpublishAtMs && unpublishAtMs <= now) return { state: "expired", visible: false };
  return { state: "published", visible: true };
}

function normalizeWallpaper(input, existing = {}) {
  const id = String(input.id || existing.id || "").trim();
  const title = String(input.title || existing.title || "").trim();
  const imageURL = String(input.imageURL || existing.imageURL || "").trim();
  const rawStatus = String(input.status ?? existing.status ?? "published").trim().toLowerCase();
  const status = new Set(["draft", "published", "hidden", "archived"]).has(rawStatus) ? rawStatus : "published";
  const nowISO = new Date().toISOString();
  const createdAt = normalizeIsoOrEmpty(existing.createdAt || input.createdAt || nowISO) || nowISO;

  if (!id || !title || !imageURL) {
    throw new Error("id, title and imageURL are required");
  }

  return {
    id,
    title,
    subtitle: String(input.subtitle ?? existing.subtitle ?? ""),
    imageURL,
    // Izgarada gösterilen küçük görsel (~420px). Boşsa app imageURL'e düşer.
    thumbURL: String(input.thumbURL ?? existing.thumbURL ?? "").trim(),
    // Live Photo'nun durağan karesi — tam çözünürlük, videonun ilk karesi.
    // Boşsa app imageURL'e düşer.
    stillURL: String(input.stillURL ?? existing.stillURL ?? "").trim(),
    // Doluysa canlı duvar kağıdı — iOS app videoyu Live Photo olarak kaydeder
    videoURL: String(input.videoURL ?? existing.videoURL ?? "").trim(),
    // Çift duvar kağıdının ikinci yarısı. Doluysa app ızgarada tek kart
    // gösterir, açılınca iki duvar kağıdı sunar (Couples kategorisi).
    partnerURL: String(input.partnerURL ?? existing.partnerURL ?? "").trim(),
    // Couples ana sayfa kartında tek bir tema kapağı gösterilir.
    // Boş bırakılırsa uygulama varsayılan Couples temasını kullanır.
    coupleCoverURL: String(input.coupleCoverURL ?? existing.coupleCoverURL ?? "").trim(),
    // Varsayılan, uygulamanın builtIn listesinde olan bir kategori olmalı —
    // aksi halde duvar kağıdı jenerik gri bir rafta görünür.
    category: String(input.category || existing.category || "Cute"),
    accentRed: Number(input.accentRed ?? existing.accentRed ?? 0.45),
    accentGreen: Number(input.accentGreen ?? existing.accentGreen ?? 0.65),
    accentBlue: Number(input.accentBlue ?? existing.accentBlue ?? 1),
    isPremium: Boolean(input.isPremium ?? existing.isPremium ?? false),
    order: Number(input.order ?? existing.order ?? 999),
    featured: Boolean(input.featured ?? existing.featured ?? false),
    status,
    publishAt: normalizeIsoOrEmpty(input.publishAt ?? existing.publishAt ?? ""),
    unpublishAt: normalizeIsoOrEmpty(input.unpublishAt ?? existing.unpublishAt ?? ""),
    createdAt,
    updatedAt: nowISO
  };
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/admin.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requested);
  } catch {
    send(res, 400, "Invalid path");
    return;
  }
  const safePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    send(res, 404, "Not found");
    return;
  }

  const body = await readFile(filePath);
  const ext = extname(filePath);
  const headers = {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000"
  };
  if (MEDIA_EXTENSIONS.has(ext)) {
    // Duvar kağıtları değişmez — bir yıl önbellekle, aynı dosya iki kez inmesin.
    headers["cache-control"] = "public, max-age=31536000, immutable";
    headers["access-control-allow-origin"] = "*";
  }
  if (ext === ".html") {
    // Panel dışarıdan hiçbir script/bağlantı yüklemez — CSP bunu zorunlu kılar:
    // XSS olsa bile çalınan veri dış sunuculara fetch ile GÖNDERİLEMEZ,
    // panel iframe içine alınıp clickjacking yapılamaz.
    headers["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src * data: blob:",
      "media-src *",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join("; ");
    headers["x-frame-options"] = "DENY";
  }
  res.writeHead(200, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    // Login doğrulaması — token doğruysa 200, yanlışsa 401
    if (req.method === "GET" && url.pathname === "/api/verify") {
      if (!requireAdmin(req, res)) return;
      send(res, 200, { ok: true, githubSync: Boolean(GITHUB_TOKEN) });
      return;
    }

    // Kullanıcı adı + şifre ile giriş → oturum token'ı döner
    if (req.method === "POST" && url.pathname === "/api/login") {
      // Brute-force koruması: IP başına 10 dakikada en fazla 5 deneme
      if (!rateLimit(req, res, "login", 5, 10 * 60_000)) return;
      const body = await parseBody(req);
      const user = adminUsers.find(
        (u) => safeEqual(u.username, body.username) && safeEqual(u.password, body.password)
      );
      if (!user) {
        await sleep(400); // başarısız denemeyi yavaşlat
        send(res, 401, { error: "Kullanıcı adı veya şifre yanlış" });
        return;
      }
      const profile = {
        username: user.username,
        displayName: user.displayName || user.username,
        title: user.title || "Admin"
      };
      const token = signSession(profile);
      send(res, 200, { token, user: profile });
      return;
    }

    // Mevcut oturumun kim olduğunu döner (sayfa yenilenince otomatik giriş)
    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = req.headers["x-admin-session"];
      const user = session ? verifySession(session) : null;
      if (!user) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      send(res, 200, { user });
      return;
    }

    // ── Kullanıcılar ────────────────────────────────────────
    // Admin: Firestore'daki tüm kullanıcıları listele (panel Kullanıcılar sekmesi)
    if (req.method === "GET" && url.pathname === "/api/users") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT env değişkeni tanımlı değil. Firebase Console → Project settings → Service accounts → Generate new private key → JSON'u Railway'e ekle." });
        return;
      }
      try {
        send(res, 200, await fetchFirebaseUsers());
      } catch (error) {
        send(res, 502, { error: error.message });
      }
      return;
    }

    // Public: iOS app her girişte kullanıcıyı buraya bildirir → sunucu
    // service account ile Firestore'a yazar (güvenlik kuralları kilitli kalır)
    if (req.method === "POST" && url.pathname === "/api/users/track") {
      if (!rateLimit(req, res, "track", 30, 60 * 60_000)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        send(res, 200, await trackFirebaseUser(await parseBody(req)));
      } catch (error) {
        send(res, 400, { error: error.message });
      }
      return;
    }

    // Admin: kullanıcıyı panelden gizle / geri getir
    // Body: { hidden: true|false } — false göndermek gizlemeyi kaldırır.
    // Panelde "geri getir" butonu yok, geri almak istersen bu endpoint'e
    // hidden:false gönder ya da Firestore Console'dan alanı sil.
    const hideMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/hide$/);
    if (hideMatch && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        const body = await parseBody(req);
        send(res, 200, await setUserHiddenOnServer(
          decodeURIComponent(hideMatch[1]),
          body.hidden !== false
        ));
      } catch (error) {
        send(res, 502, { error: error.message });
      }
      return;
    }

    // Admin: kullanıcı belgesini KALICI sil
    // (kullanıcı uygulamayı tekrar açarsa yeni kayıt olarak geri gelir)
    const userDelMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userDelMatch && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        send(res, 200, await deleteUserOnServer(decodeURIComponent(userDelMatch[1])));
      } catch (error) {
        send(res, 502, { error: error.message });
      }
      return;
    }

    // Public: kullanıcının abonelik durumu — iOS Firestore'u okuyamazsa buraya sorar
    const subMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/subscription$/);
    if (subMatch && req.method === "GET") {
      if (!rateLimit(req, res, "sub", 120, 60 * 60_000)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        send(res, 200, await readSubscriptionOnServer(decodeURIComponent(subMatch[1])));
      } catch (error) {
        send(res, 502, { error: error.message });
      }
      return;
    }

    // Uygulama görünüm ayarları — iOS app okur (public), panel yazar (admin)
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJSONFresh(res, 200, await readConfig());
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/config") {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const current = await readConfig();
      const next = {
        ...current,
        ...body,
        snow: { ...current.snow, ...(body.snow || {}) },
        announcement: { ...current.announcement, ...(body.announcement || {}) },
        wallpapers: { ...current.wallpapers, ...(body.wallpapers || {}) },
        themes: { ...current.themes, ...(body.themes || {}) },
        paywall: { ...current.paywall, ...(body.paywall || {}) },
        effect: { ...current.effect, ...(body.effect || {}) }
      };
      await writeConfig(next);
      send(res, 200, next);
      return;
    }

    // ── Dönüşüm olayları ────────────────────────────────────
    // Public: iOS app paywall gösterimi / satın alma bildirir
    if (req.method === "POST" && url.pathname === "/api/events") {
      if (!rateLimit(req, res, "events", 120, 60 * 60_000)) return;
      try {
        await recordEvent(await parseBody(req));
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
      return;
    }

    // Admin: günlük sayaçları döner (panel Paywall sekmesi)
    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!requireAdmin(req, res)) return;
      send(res, 200, await readEvents());
      return;
    }

    // ── Push bildirimi ──────────────────────────────────────
    // Admin: segmentteki kullanıcılara push gönder
    if (req.method === "POST" && url.pathname === "/api/push") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "Push için FIREBASE_SERVICE_ACCOUNT gerekli" });
        return;
      }
      try {
        send(res, 200, await sendPushCampaign(await parseBody(req)));
      } catch (error) {
        send(res, 400, { error: error.message });
      }
      return;
    }

    // Admin: gönderim geçmişi
    if (req.method === "GET" && url.pathname === "/api/push") {
      if (!requireAdmin(req, res)) return;
      send(res, 200, await readPushHistory());
      return;
    }

    // Admin: kaç kullanıcıya ulaşılabilir (göndermeden önce önizleme)
    if (req.method === "GET" && url.pathname === "/api/push/reach") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        const users = await fetchFirebaseUsers();
        const now = new Date();
        const isPremium = (u) => {
          const sub = u.subscription;
          if (!sub || sub.isActive !== true) return false;
          const pid = String(sub.productID || "");
          if (REVOKED_PRODUCT_PREFIXES.some((p) => pid.startsWith(p))) return false;
          const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
          return !exp || exp > now;
        };
        const withToken = users.filter((u) => typeof u.fcmToken === "string" && u.fcmToken);
        send(res, 200, {
          totalUsers: users.length,
          all: withToken.length,
          premium: withToken.filter(isPremium).length,
          nonpremium: withToken.filter((u) => !isPremium(u)).length
        });
      } catch (error) {
        send(res, 502, { error: error.message });
      }
      return;
    }

    // Admin: RevenueCat gelir metrikleri (panel Gelir sekmesi)
    // ?force=1 → önbelleği atla
    if (req.method === "GET" && url.pathname === "/api/revenue") {
      if (!requireAdmin(req, res)) return;
      try {
        send(res, 200, await fetchRevenueCatOverview({ force: url.searchParams.get("force") === "1" }));
      } catch (error) {
        send(res, error.statusCode || 502, { error: error.message });
      }
      return;
    }

    // ── RevenueCat webhook ──────────────────────────────────
    // RevenueCat → Project settings → Integrations → Webhooks
    //   URL                 : https://<railway-domain>/api/revenuecat/webhook
    //   Authorization header: REVENUECAT_WEBHOOK_SECRET ile aynı değer
    //
    // Admin oturumu YOK — kimlik doğrulama paylaşılan sır ile yapılır.
    if (req.method === "POST" && url.pathname === "/api/revenuecat/webhook") {
      if (!REVENUECAT_WEBHOOK_SECRET) {
        send(res, 501, { error: "REVENUECAT_WEBHOOK_SECRET tanımlı değil" });
        return;
      }
      if (!safeEqual(req.headers.authorization || "", REVENUECAT_WEBHOOK_SECRET)) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      // Firebase kontrolü bilerek burada yok: RevenueCat panelindeki
      // "Send test event" butonu URL + sır doğruluğunu Firestore'a hiç
      // dokunmadan teyit edebilsin. Gerçek yazma anında zaten hata fırlar.
      try {
        const body = await parseBody(req);
        const result = await handleRevenueCatEvent(body?.event || {});
        send(res, 200, { ok: true, ...result });
      } catch (error) {
        // 5xx dönersek RevenueCat tekrar dener — kalıcı hatalarda bu istenir
        send(res, 500, { error: error.message });
      }
      return;
    }

    // Admin: mevcut aboneleri RevenueCat'ten çekip Firestore'u doldur
    if (req.method === "POST" && url.pathname === "/api/revenue/sync") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "FIREBASE_SERVICE_ACCOUNT tanımlı değil" });
        return;
      }
      try {
        send(res, 200, await syncSubscriptionsFromRevenueCat({}));
      } catch (error) {
        send(res, error.statusCode || 502, { error: error.message });
      }
      return;
    }

    // ── Toplu hediye kampanyası ─────────────────────────────
    // Admin: bir segmentteki TÜM kullanıcılara hediye oluşturur
    if (req.method === "POST" && url.pathname === "/api/gifts/bulk") {
      if (!requireAdmin(req, res)) return;
      if (!firebaseServiceAccount()) {
        send(res, 501, { error: "Toplu kampanya için FIREBASE_SERVICE_ACCOUNT gerekli (kullanıcı listesi oradan geliyor)" });
        return;
      }
      try {
        const body = await parseBody(req);
        const target = String(body.target || "all"); // all | premium | nonpremium
        const users = await fetchFirebaseUsers();
        const now = new Date();

        // Kaldırılan otomatik hoşgeldin hediyesi (welcome.*) premium sayılmaz —
        // aksi halde "premium olmayanlara kampanya" segmenti bu kişileri atlar.
        const isPremium = (u) => {
          const sub = u.subscription;
          if (!sub || sub.isActive !== true) return false;
          const pid = String(sub.productID || "");
          if (REVOKED_PRODUCT_PREFIXES.some((p) => pid.startsWith(p))) return false;
          const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
          return !exp || exp > now;
        };

        const selected = users.filter((u) => {
          if (!u.docID) return false;
          if (target === "premium") return isPremium(u);
          if (target === "nonpremium") return !isPremium(u);
          return true;
        });

        if (selected.length === 0) {
          send(res, 400, { error: "Bu segmentte kullanıcı yok" });
          return;
        }

        const gifts = await readGifts();
        const campaignNote = String(body.note || "").slice(0, 200);
        let created = 0;
        for (const user of selected) {
          try {
            gifts.push(normalizeGift({
              userID: user.docID,
              kind: body.kind,
              premiumDays: body.premiumDays,
              coins: body.coins,
              petType: body.petType,
              note: campaignNote
            }));
            created += 1;
          } catch { /* geçersiz tek kullanıcı kampanyayı durdurmasın */ }
        }
        await writeGifts(gifts);
        send(res, 201, { created, target });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
      return;
    }

    // ── Hediye API ──────────────────────────────────────────
    // Admin: tüm hediyeleri listele
    if (req.method === "GET" && url.pathname === "/api/gifts") {
      if (!requireAdmin(req, res)) return;
      const gifts = await readGifts();
      send(res, 200, gifts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
      return;
    }

    // Admin: yeni hediye oluştur
    if (req.method === "POST" && url.pathname === "/api/gifts") {
      if (!requireAdmin(req, res)) return;
      const gift = normalizeGift(await parseBody(req));
      const gifts = await readGifts();
      gifts.push(gift);
      await writeGifts(gifts);

      // Premium hediyesi ise Firestore'a hemen yaz (gönder + aktivasyon)
      if (gift.kind === "premium" && gift.premiumDays > 0 && firebaseServiceAccount()) {
        try {
          await grantPremiumOnServer(gift.userID, gift.premiumDays);
        } catch (error) {
          console.warn("Premium yazılamadı:", error.message);
          // Hediye kaydı yazıldı, Firestore yazması başarısız olsa bile devam et
        }
      }

      send(res, 201, gift);
      return;
    }

    // Admin: hediye sil (henüz alınmamışsa geri çekme)
    const giftMatch = url.pathname.match(/^\/api\/gifts\/([^/]+)$/);
    if (giftMatch && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(giftMatch[1]);
      const gifts = await readGifts();
      const next = gifts.filter((g) => g.id !== id);
      await writeGifts(next);
      send(res, 200, { deleted: gifts.length - next.length });
      return;
    }

    // Public: kullanıcının bekleyen hediyeleri (iOS app açılışta çağırır)
    const pendingMatch = url.pathname.match(/^\/api\/gifts\/pending\/([^/]+)$/);
    if (pendingMatch && req.method === "GET") {
      if (!rateLimit(req, res, "gifts", 120, 60 * 60_000)) return;
      const userID = decodeURIComponent(pendingMatch[1]);
      const gifts = await readGifts();
      send(res, 200, gifts.filter((g) => g.userID === userID && !g.claimed));
      return;
    }

    // Public: hediyeleri alındı olarak işaretle
    if (req.method === "POST" && url.pathname === "/api/gifts/claim") {
      if (!rateLimit(req, res, "gifts", 120, 60 * 60_000)) return;
      const body = await parseBody(req);
      const userID = String(body.userID || "").trim();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!userID || ids.length === 0) {
        send(res, 400, { error: "userID and ids are required" });
        return;
      }
      const gifts = await readGifts();
      let updated = 0;
      let premiumDays = 0;
      for (const gift of gifts) {
        // Sadece kendi userID'sine ait hediyeler claim edilebilir
        if (ids.includes(gift.id) && gift.userID === userID && !gift.claimed) {
          gift.claimed = true;
          gift.claimedAt = new Date().toISOString();
          updated += 1;
          if (gift.kind === "premium") premiumDays += Number(gift.premiumDays) || 0;
        }
      }
      if (updated > 0) await writeGifts(gifts);

      // Premium hediyesini SUNUCU yazar — cihazdan yazma Firestore kurallarına takılıyordu
      let premium = null;
      if (premiumDays > 0 && firebaseServiceAccount()) {
        try {
          premium = await grantPremiumOnServer(userID, premiumDays);
        } catch (error) {
          console.warn("Premium hediye yazılamadı:", error.message);
        }
      }
      send(res, 200, { claimed: updated, premium });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/wallpapers") {
      const allItems = await readWallpapers();
      const decorated = allItems
        .map((item) => {
          const life = wallpaperLifecycle(item);
          return { ...item, effectiveState: life.state, isVisibleNow: life.visible };
        })
        .sort((a, b) => Number(a.order || 999) - Number(b.order || 999));
      const wantsAdmin = url.searchParams.get("admin") === "1" && isAdminRequest(req);
      const items = wantsAdmin ? decorated : decorated.filter((item) => item.isVisibleNow);
      sendJSONFresh(res, 200, items);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/widgets") {
      sendJSONFresh(res, 200, await readWidgets());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallpapers") {
      if (!requireAdmin(req, res)) return;
      const items = await readWallpapers();
      const item = normalizeWallpaper(await parseBody(req));
      if (items.some((w) => w.id === item.id)) {
        send(res, 409, { error: "Wallpaper id already exists" });
        return;
      }
      items.push(item);
      await writeWallpapers(items);
      send(res, 201, item);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallpapers/bulk") {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const action = String(body.action || "").trim();
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
      if (!ids.length) {
        send(res, 400, { error: "ids are required" });
        return;
      }

      const items = await readWallpapers();
      const target = new Set(ids);
      const selected = items.filter((item) => target.has(item.id));
      if (!selected.length) {
        send(res, 404, { error: "No wallpapers matched ids" });
        return;
      }

      if (action === "delete") {
        const next = items.filter((item) => !target.has(item.id));
        await writeWallpapers(next);
        send(res, 200, { action, affected: items.length - next.length });
        return;
      }

      if (action === "moveCategory") {
        const category = String(body.category || "").trim();
        if (!category) {
          send(res, 400, { error: "category is required" });
          return;
        }
        const nowISO = new Date().toISOString();
        for (const item of items) {
          if (target.has(item.id)) {
            item.category = category;
            item.updatedAt = nowISO;
          }
        }
        await writeWallpapers(items);
        send(res, 200, { action, affected: selected.length, category });
        return;
      }

      if (action === "setPremium") {
        const isPremium = Boolean(body.isPremium);
        const nowISO = new Date().toISOString();
        for (const item of items) {
          if (target.has(item.id)) {
            item.isPremium = isPremium;
            item.updatedAt = nowISO;
          }
        }
        await writeWallpapers(items);
        send(res, 200, { action, affected: selected.length, isPremium });
        return;
      }

      if (action === "setFeatured") {
        const featured = Boolean(body.featured);
        const nowISO = new Date().toISOString();
        for (const item of items) {
          if (target.has(item.id)) {
            item.featured = featured;
            item.updatedAt = nowISO;
          }
        }
        await writeWallpapers(items);
        send(res, 200, { action, affected: selected.length, featured });
        return;
      }

      if (action === "setStatus") {
        const status = String(body.status || "").trim().toLowerCase();
        if (!new Set(["draft", "published", "hidden", "archived"]).has(status)) {
          send(res, 400, { error: "invalid status" });
          return;
        }
        const publishAt = Object.prototype.hasOwnProperty.call(body, "publishAt")
          ? normalizeIsoOrEmpty(body.publishAt)
          : undefined;
        const unpublishAt = Object.prototype.hasOwnProperty.call(body, "unpublishAt")
          ? normalizeIsoOrEmpty(body.unpublishAt)
          : undefined;
        const nowISO = new Date().toISOString();
        for (const item of items) {
          if (!target.has(item.id)) continue;
          item.status = status;
          if (publishAt !== undefined) item.publishAt = publishAt;
          if (unpublishAt !== undefined) item.unpublishAt = unpublishAt;
          item.updatedAt = nowISO;
        }
        await writeWallpapers(items);
        send(res, 200, { action, affected: selected.length, status, publishAt, unpublishAt });
        return;
      }

      if (action === "applyOrder") {
        const orderedIDs = Array.isArray(body.orderedIDs)
          ? body.orderedIDs.map((id) => String(id || "").trim()).filter(Boolean)
          : ids;
        const index = Object.fromEntries(orderedIDs.map((id, i) => [id, i]));
        const nowISO = new Date().toISOString();
        for (const item of items) {
          if (!target.has(item.id) || index[item.id] == null) continue;
          item.order = (index[item.id] + 1) * 10;
          item.updatedAt = nowISO;
        }
        await writeWallpapers(items);
        send(res, 200, { action, affected: selected.length });
        return;
      }

      send(res, 400, { error: "Unknown bulk action" });
      return;
    }

    // ── Kategori toplu işlemi ────────────────────────────────
    // Bir kategorinin tüm duvar kağıtlarını başka kategoriye taşır ya da siler.
    // Panelde "Kategori Yönetimi" bölümü kullanır.
    //   { action: "move", category: "City", target: "Nature" }
    //   { action: "delete", category: "Seasonal" }
    if (req.method === "POST" && url.pathname === "/api/wallpapers/category") {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const action = String(body.action || "");
      const category = String(body.category || "").trim();

      if (!category) {
        send(res, 400, { error: "category is required" });
        return;
      }

      const items = await readWallpapers();
      const affected = items.filter((w) => w.category === category);

      if (action === "move") {
        const target = String(body.target || "").trim();
        if (!target) {
          send(res, 400, { error: "target is required for move" });
          return;
        }
        if (target === category) {
          send(res, 400, { error: "target must differ from category" });
          return;
        }
        for (const w of items) {
          if (w.category === category) w.category = target;
        }
        await writeWallpapers(items);
        send(res, 200, { action, category, target, affected: affected.length });
        return;
      }

      if (action === "delete") {
        const next = items.filter((w) => w.category !== category);
        await writeWallpapers(next);
        send(res, 200, { action, category, affected: items.length - next.length });
        return;
      }

      send(res, 400, { error: "action must be 'move' or 'delete'" });
      return;
    }

    const match = url.pathname.match(/^\/api\/wallpapers\/([^/]+)$/);
    if (match && req.method === "PUT") {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(match[1]);
      const items = await readWallpapers();
      const index = items.findIndex((w) => w.id === id);
      if (index === -1) {
        send(res, 404, { error: "Wallpaper not found" });
        return;
      }
      items[index] = normalizeWallpaper({ ...(await parseBody(req)), id }, items[index]);
      await writeWallpapers(items);
      send(res, 200, items[index]);
      return;
    }

    if (match && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(match[1]);
      const items = await readWallpapers();
      const next = items.filter((w) => w.id !== id);
      await writeWallpapers(next);
      send(res, 200, { deleted: items.length - next.length });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
});

await pullFileFromGitHub(GITHUB_DATA_PATH, DATA_FILE);
await pullFileFromGitHub(GITHUB_CONFIG_PATH, CONFIG_FILE);
await pullFileFromGitHub(GITHUB_GIFTS_PATH, GIFTS_FILE);
await pullFileFromGitHub(GITHUB_EVENTS_PATH, EVENTS_FILE);
await pullFileFromGitHub(GITHUB_PUSH_PATH, PUSH_FILE);

if (ADMIN_TOKEN === "change-me") {
  console.warn("⚠️  ADMIN_TOKEN varsayılan değerde! Railway'de güçlü bir ADMIN_TOKEN ayarla.");
}
if (!process.env.SESSION_SECRET) {
  console.warn("ℹ️  SESSION_SECRET tanımlı değil — oturum imzası ADMIN_TOKEN ile atılıyor (çalışır ama ayrı bir değer daha güvenli).");
}

server.listen(PORT, () => {
  console.log(`Wallpaper server listening on http://localhost:${PORT}`);
});
