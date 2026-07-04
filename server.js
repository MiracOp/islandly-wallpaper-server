import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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

// Uygulama görünüm ayarları (kar modu vb.) — panelden yönetilir
const DEFAULT_CONFIG = {
  theme: "default",
  snow: { enabled: false, intensity: 60, speed: 1, size: 1 }
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
const sessions = new Map(); // sessionToken → kullanıcı profili

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
    return { ...DEFAULT_CONFIG, ...raw, snow: { ...DEFAULT_CONFIG.snow, ...(raw.snow || {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config) {
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  pushFileToGitHub(GITHUB_CONFIG_PATH, config,
    "chore: update app config via admin panel [skip railway]"); // arka planda
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-token,x-admin-session",
    ...headers
  });
  res.end(payload);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireAdmin(req, res) {
  // 1) Kullanıcı oturumu (Nisa vb.) 2) Eski usül admin token — ikisi de geçerli
  const session = req.headers["x-admin-session"];
  if (session && sessions.has(session)) return true;
  if (req.headers["x-admin-token"] === ADMIN_TOKEN) return true;
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
  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
  });
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
      const body = await parseBody(req);
      const user = adminUsers.find(
        (u) => u.username === body.username && u.password === body.password
      );
      if (!user) {
        send(res, 401, { error: "Kullanıcı adı veya şifre yanlış" });
        return;
      }
      const token = randomUUID();
      const profile = {
        username: user.username,
        displayName: user.displayName || user.username,
        title: user.title || "Admin"
      };
      sessions.set(token, profile);
      send(res, 200, { token, user: profile });
      return;
    }

    // Mevcut oturumun kim olduğunu döner (sayfa yenilenince otomatik giriş)
    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = req.headers["x-admin-session"];
      const user = session ? sessions.get(session) : null;
      if (!user) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      send(res, 200, { user });
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
        snow: { ...current.snow, ...(body.snow || {}) }
      };
      await writeConfig(next);
      send(res, 200, next);
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

server.listen(PORT, () => {
  console.log(`Wallpaper server listening on http://localhost:${PORT}`);
});
