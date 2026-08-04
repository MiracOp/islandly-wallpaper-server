import { createServer } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

// Uygulama görünüm ayarları (kar modu vb.) — panelden yönetilir
const DEFAULT_CONFIG = {
  theme: "default",
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
  // Tema yönetimi — uygulama güncellemesi olmadan panelden kontrol
  themes: {
    freeThemeNames: [],      // bu isimli temalar premium'suz kullanılabilir (app'teki isFree'ye ek)
    featuredThemeName: "",   // haftanın teması — listede öne çıkarılır
    disabledCategories: []   // bu kategoriler app'te gizlenir
  },
  // Paywall kontrolü — trial ve fiyat seti (A/B testi için product ID override)
  paywall: {
    trialEnabled: true,
    monthlyProductID: "",    // boş = app'teki varsayılan ID
    yearlyProductID: ""      // boş = app'teki varsayılan ID
  },
  // Ekran efekti — kar modunun genellenmişi (none | snow | confetti | hearts | leaves)
  effect: { type: "none", intensity: 60, speed: 1, size: 1 },
  // Premium olmayan kullanıcılara review banner kampanyası
  reviewPromoBanner: {
    enabled: false,
    premiumDays: 3,
    translations: {
      en: "Rate us 5 stars and get 3 days free premium!",
      tr: "5 Yıldız atarsanız 3 günlük deneme alın!",
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

// ── Firebase (kullanıcı listesi + login takibi) ──────────────
// Railway'de FIREBASE_SERVICE_ACCOUNT env değişkenine Firebase Console →
// Project settings → Service accounts → "Generate new private key" ile inen
// JSON'un TAMAMI yapıştırılır. Service account Firestore kurallarını bypass
// eder — kurallar kilitli kalabilir (güvenli), yazma sunucudan yapılır.
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || "";
let fbTokenCache = { token: "", exp: 0 };

function firebaseServiceAccount() {
  if (!FIREBASE_SERVICE_ACCOUNT) return null;
  try { return JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch { return null; }
}

async function firebaseAccessToken() {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil veya geçersiz JSON");
  if (fbTokenCache.token && Date.now() < fbTokenCache.exp - 60_000) return fbTokenCache.token;

  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
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
  fbTokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return fbTokenCache.token;
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

/** Kullanıcının abonelik durumunu döner — iOS Firestore'u okuyamazsa buraya sorar. */
async function readSubscriptionOnServer(userID) {
  const sa = firebaseServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT tanımlı değil");
  const token = await firebaseAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const res = await fetch(`${base}/users/${encodeURIComponent(userID)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) return { isActive: false, expiresAt: null };
  const doc = await res.json();
  const sub = doc.fields?.subscription?.mapValue?.fields;
  if (!sub) return { isActive: false, expiresAt: null };
  const expiresAt = sub.expiresAt?.timestampValue || null;
  const flag = sub.isActive?.booleanValue === true;
  const notExpired = !expiresAt || new Date(expiresAt) > new Date();
  return { isActive: flag && notExpired, expiresAt };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

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

function requireAdmin(req, res) {
  // 1) Kullanıcı oturumu (imzalı token) 2) Eski usül admin token — ikisi de geçerli
  const session = req.headers["x-admin-session"];
  if (session && verifySession(session)) return true;
  if (req.headers["x-admin-token"] && safeEqual(req.headers["x-admin-token"], ADMIN_TOKEN)) return true;
  send(res, 401, { error: "Unauthorized" });
  return false;
}

function normalizeWallpaper(input, existing = {}) {
  const id = String(input.id || existing.id || "").trim();
  const title = String(input.title || existing.title || "").trim();
  const imageURL = String(input.imageURL || existing.imageURL || "").trim();

  if (!id || !title || !imageURL) {
    throw new Error("id, title and imageURL are required");
  }

  return {
    id,
    title,
    subtitle: String(input.subtitle ?? existing.subtitle ?? ""),
    imageURL,
    // Doluysa canlı duvar kağıdı — iOS app videoyu Live Photo olarak kaydeder
    videoURL: String(input.videoURL ?? existing.videoURL ?? "").trim(),
    category: String(input.category || existing.category || "Nature"),
    accentRed: Number(input.accentRed ?? existing.accentRed ?? 0.45),
    accentGreen: Number(input.accentGreen ?? existing.accentGreen ?? 0.65),
    accentBlue: Number(input.accentBlue ?? existing.accentBlue ?? 1),
    isPremium: Boolean(input.isPremium ?? existing.isPremium ?? false),
    order: Number(input.order ?? existing.order ?? 999)
  };
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/admin.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
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
      send(res, 200, await readConfig());
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

        const isPremium = (u) => {
          const sub = u.subscription;
          if (!sub || sub.isActive !== true) return false;
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
      const items = await readWallpapers();
      send(res, 200, items.sort((a, b) => Number(a.order || 999) - Number(b.order || 999)));
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

if (ADMIN_TOKEN === "change-me") {
  console.warn("⚠️  ADMIN_TOKEN varsayılan değerde! Railway'de güçlü bir ADMIN_TOKEN ayarla.");
}
if (!process.env.SESSION_SECRET) {
  console.warn("ℹ️  SESSION_SECRET tanımlı değil — oturum imzası ADMIN_TOKEN ile atılıyor (çalışır ama ayrı bir değer daha güvenli).");
}

server.listen(PORT, () => {
  console.log(`Wallpaper server listening on http://localhost:${PORT}`);
});
