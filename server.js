// awzers — sunucu (Express + SQLite + session auth + IP ban + bakım modu)
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const session = require("express-session");
const ROOT = __dirname;
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DATA_DIR = path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // Cloudflare/ngrok arkasi icin gercek IP
const compression = require("compression");
app.use(compression({ level: 6 })); // gzip sikistirma
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

const db = new Database(path.join(DATA_DIR, "selenite.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---- sema ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  avatar_color TEXT NOT NULL DEFAULT '#8b5cf6',
  banned INTEGER NOT NULL DEFAULT 0,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  directory TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT 'cover.svg',
  recommended INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_games_dir ON games(directory);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  game_dir TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ip_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const getSetting = (k, def = null) => { const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k); return r ? r.value : def; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));

const q = {
  userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  allUsers: db.prepare("SELECT id, username, role, avatar_color, banned, last_login, created_at FROM users ORDER BY id"),
  addUser: db.prepare("INSERT INTO users (username, password_hash, role, avatar_color) VALUES (?, ?, ?, ?)"),
  delUser: db.prepare("DELETE FROM users WHERE id = ? AND username != '0000'"),
  updUser: db.prepare("UPDATE users SET username = ?, role = ?, banned = ? WHERE id = ? AND username != '0000'"),
  updPass: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  allGames: db.prepare("SELECT * FROM games ORDER BY recommended DESC, name COLLATE NOCASE"),
  visibleGames: db.prepare("SELECT * FROM games WHERE hidden = 0 ORDER BY recommended DESC, name COLLATE NOCASE"),
  gameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  gameByDir: db.prepare("SELECT * FROM games WHERE directory = ?"),
  addGame: db.prepare("INSERT INTO games (name, directory, image, recommended, added_by) VALUES (?, ?, ?, ?, ?)"),
  delGame: db.prepare("DELETE FROM games WHERE id = ?"),
  setHidden: db.prepare("UPDATE games SET hidden = ? WHERE id = ?"),
  log: db.prepare("INSERT INTO audit_log (actor, action, target) VALUES (?, ?, ?)"),
  logs: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200"),
  plays: db.prepare("INSERT INTO plays (user_id, game_dir) VALUES (?, ?)"),
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM users WHERE role='admin') AS admins,
    (SELECT COUNT(*) FROM games) AS games,
    (SELECT COUNT(*) FROM games WHERE hidden=1) AS hidden_games,
    (SELECT COUNT(*) FROM plays) AS plays,
    (SELECT COUNT(*) FROM ip_bans) AS ip_bans`),
  ipBans: db.prepare("SELECT * FROM ip_bans ORDER BY id DESC"),
  ipBanByIp: db.prepare("SELECT * FROM ip_bans WHERE ip = ?"),
  addIpBan: db.prepare("INSERT INTO ip_bans (ip, reason) VALUES (?, ?)"),
  delIpBan: db.prepare("DELETE FROM ip_bans WHERE id = ?"),
};

// ---- IP ----
function clientIp(req) {
  const fwd = req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || req.ip || "";
}

// ---- bakım modu + IP ban middleware (TÜM isteklerde) ----
// NOT: session middleware'inden SONRA çalışmalı (admin kontrolü için)
// Bu yüzden app.use(session(...)) tanımından sonra taşınacak.
let maintenanceMiddleware = (req, res, next) => next();

// ---- session ----
const MemoryStore = require("memorystore");
const MemoryStoreClass = MemoryStore(session);
const store = new MemoryStoreClass({ checkPeriod: 86400000 });

app.use(session({
  store,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ---- bakım modu + IP ban (session'dan SONRA) ----
app.use((req, res, next) => {
  const ip = clientIp(req);
  const u = req.session.userId ? q.userById.get(req.session.userId) : null;
  const isAdmin = u && u.role === "admin";
  // IP ban: adminler banı atlar (kendini kilitlemesin)
  const ban = q.ipBanByIp.get(ip);
  if (ban && !isAdmin) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "IP adresiniz banlandı", banned: true });
    return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Banlandınız</title>
<style>body{background:#07060d;color:#ece9f7;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
.b{max-width:420px;padding:40px}h1{color:#f43f5e;font-size:28px}p{color:#8f8ab0;margin-top:12px}</style></head>
<body><div class="b"><h1>⛔ Erişiminiz Engellendi</h1><p>IP adresiniz banlanmıştır.</p><p>${ban.reason ? "Sebep: " + ban.reason : ""}</p></div></body></html>`);
  }
  if (getSetting("maintenance") === "1") {
    if (isAdmin) return next(); // admin her şeye erişebilir
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/") && req.path !== "/api/status") {
      return res.status(503).json({ error: "Site bakımda", maintenance: true });
    }
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/app.css") && !req.path.startsWith("/app.js") && !req.path.startsWith("/favicon")) {
      return res.status(503).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bakımda</title>
<style>body{background:#07060d;color:#ece9f7;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;overflow:hidden}
.b{max-width:440px;padding:40px;position:relative;z-index:2}h1{color:#a78bfa;font-size:30px}p{color:#8f8ab0;margin-top:14px;line-height:1.6}
.spin{width:44px;height:44px;border:3px solid #262241;border-top-color:#a78bfa;border-radius:50%;margin:24px auto 0;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><div class="b"><h1>🔧 awzers bakımda</h1><p>Site şu anda bakımda. Kısa süre içinde geri döneceğiz.</p><div class="spin"></div></div></body></html>`);
    }
  }
  next();
});

const audit = (actor, action, target) => q.log.run(actor, action, target || null);
const publicUser = (u) => u && ({ id: u.id, username: u.username, role: u.role, avatar_color: u.avatar_color, banned: !!u.banned, last_login: u.last_login });
const colors = ["#8b5cf6", "#f43f5e", "#06b6d4", "#10b981", "#f59e0b", "#ec4899"];

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Giriş yapman gerekiyor" });
  const u = q.userById.get(req.session.userId);
  if (!u || u.banned) { req.session.destroy(() => {}); return res.status(401).json({ error: "Oturum geçersiz" }); }
  req.user = u; next();
};
const requireAdmin = (req, res, next) => requireAuth(req, res, () => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Yetkisiz erişim" });
  next();
});

// ---- durum (herkes görebilir) ----
app.get("/api/status", (req, res) => {
  res.json({ maintenance: getSetting("maintenance") === "1" });
});

// ---- auth API ----
app.post("/api/auth/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-20 karakter, sadece harf/rakam/alt çizgi" });
  if (password.length < 6) return res.status(400).json({ error: "Şifre en az 6 karakter olmalı" });
  if (q.userByName.get(username)) return res.status(409).json({ error: "Bu kullanıcı adı zaten alınmış" });
  const color = colors[Math.floor(Math.random() * colors.length)];
  const info = q.addUser.run(username, bcrypt.hashSync(password, 10), "user", color);
  q.touchLogin.run(info.lastInsertRowid);
  req.session.userId = info.lastInsertRowid;
  audit(username, "register", clientIp(req));
  res.json({ user: publicUser(q.userById.get(info.lastInsertRowid)) });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const u = q.userByName.get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
  if (u.banned) return res.status(403).json({ error: "Hesabınız yasaklanmış" });
  q.touchLogin.run(u.id);
  req.session.userId = u.id;
  audit(u.username, "login", clientIp(req));
  res.json({ user: publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => {
  const name = req.session.userId ? (q.userById.get(req.session.userId) || {}).username : "?";
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    if (name !== "?") audit(name, "logout", null);
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null, maintenance: getSetting("maintenance") === "1" });
  const u = q.userById.get(req.session.userId);
  res.json({ user: u ? publicUser(u) : null, maintenance: getSetting("maintenance") === "1" });
});

// ---- games API ----
app.get("/api/games", (req, res) => {
  const u = req.session.userId ? q.userById.get(req.session.userId) : null;
  const isAdmin = u && u.role === "admin";
  res.json({ games: (isAdmin ? q.allGames.all() : q.visibleGames.all()).map(g => ({ ...g, recommended: !!g.recommended, hidden: !!g.hidden })) });
});

app.post("/api/games/:id/play", requireAuth, (req, res) => {
  const g = q.gameById.get(req.params.id);
  if (!g || g.hidden) return res.status(404).json({ error: "Oyun bulunamadı" });
  q.plays.run(req.user.id, g.directory);
  res.json({ ok: true });
});

app.post("/api/games", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const directory = String(req.body.directory || "").trim().replace(/^\/+|\/+$/g, "");
  const image = String(req.body.image || "cover.svg").trim();
  const recommended = req.body.recommended ? 1 : 0;
  if (!name || name.length > 60) return res.status(400).json({ error: "Geçerli bir oyun adı girin" });
  if (!/^[a-zA-Z0-9_\-]+$/.test(directory)) return res.status(400).json({ error: "Klasör adı sadece harf/rakam/tire/alt çizgi" });
  if (!fs.existsSync(path.join(ROOT, directory))) return res.status(400).json({ error: `'${directory}' klasörü sunucuda bulunamadı` });
  if (q.gameByDir.get(directory)) return res.status(409).json({ error: "Bu klasör zaten kayıtlı" });
  if (!/^[a-zA-Z0-9_\-.\/]+$/.test(image) || image.includes("..")) return res.status(400).json({ error: "Geçersiz resim yolu" });
  const info = q.addGame.run(name, directory, image, recommended, req.user.id);
  audit(req.user.username, "game-add", `${name} (${directory})`);
  res.json({ game: { ...q.gameById.get(info.lastInsertRowid), recommended: !!recommended } });
});

app.patch("/api/games/:id", requireAdmin, (req, res) => {
  const g = q.gameById.get(req.params.id);
  if (!g) return res.status(404).json({ error: "Oyun bulunamadı" });
  const name = String(req.body.name || g.name).trim();
  if (!name || name.length > 60) return res.status(400).json({ error: "Geçersiz ad" });
  db.prepare("UPDATE games SET name = ?, recommended = ?, hidden = ? WHERE id = ?")
    .run(name, req.body.recommended ? 1 : 0, req.body.hidden ? 1 : 0, g.id);
  audit(req.user.username, "game-edit", `${name} (${g.directory})`);
  res.json({ game: { ...q.gameById.get(g.id), recommended: !!q.gameById.get(g.id).recommended, hidden: !!q.gameById.get(g.id).hidden } });
});

app.delete("/api/games/:id", requireAdmin, (req, res) => {
  const g = q.gameById.get(req.params.id);
  if (!g) return res.status(404).json({ error: "Oyun bulunamadı" });
  q.delGame.run(g.id);
  audit(req.user.username, "game-delete", `${g.name} (${g.directory})`);
  res.json({ ok: true });
});

// ---- admin API ----
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json(q.stats.get());
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ users: q.allUsers.all().map(publicUser) });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "user";
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-20 karakter" });
  if (password.length < 6) return res.status(400).json({ error: "Şifre en az 6 karakter" });
  if (q.userByName.get(username)) return res.status(409).json({ error: "Kullanıcı zaten var" });
  const info = q.addUser.run(username, bcrypt.hashSync(password, 10), role, colors[Math.floor(Math.random() * colors.length)]);
  audit(req.user.username, "user-create", `${username} (${role})`);
  res.json({ user: publicUser(q.userById.get(info.lastInsertRowid)) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
  if (u.username === "0000") return res.status(403).json({ error: "Ana admin değiştirilemez" });
  const username = String(req.body.username || u.username).trim();
  const role = req.body.role === "admin" ? "admin" : "user";
  const banned = req.body.banned ? 1 : 0;
  const ipBan = req.body.ipBan ? 1 : 0;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-20 karakter" });
  const clash = q.userByName.get(username);
  if (clash && clash.id !== u.id) return res.status(409).json({ error: "Kullanıcı adı kullanımda" });
  if (req.body.password && String(req.body.password).length >= 6) q.updPass.run(bcrypt.hashSync(String(req.body.password), 10), u.id);
  q.updUser.run(username, role, banned, u.id);
  // Kullanıcı banlanırken IP ban seçiliyse son IP'sini banla
  let bannedIp = null;
  if (banned && ipBan) {
    const lastIp = db.prepare("SELECT target FROM audit_log WHERE actor = ? AND action = 'login' ORDER BY id DESC LIMIT 1").get(u.username);
    if (lastIp && lastIp.target && /^[0-9a-fA-F.:]{3,45}$/.test(lastIp.target)) {
      try { q.addIpBan.run(lastIp.target, `${u.username} banlandı`); bannedIp = lastIp.target; audit(req.user.username, "ip-ban", lastIp.target); } catch (e) {}
    }
  }
  audit(req.user.username, "user-update", `${u.username} -> ${username} (${role}${banned ? ", banned" : ""}${bannedIp ? ", ip:" + bannedIp : ""})`);
  res.json({ user: publicUser(q.userById.get(u.id)), bannedIp });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const u = q.userById.get(req.params.id);
  if (!u) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
  if (u.username === "0000") return res.status(403).json({ error: "Ana admin silinemez" });
  q.delUser.run(u.id);
  audit(req.user.username, "user-delete", u.username);
  res.json({ ok: true });
});

// ---- IP ban yönetimi ----
app.get("/api/admin/ipbans", requireAdmin, (req, res) => {
  res.json({ ipbans: q.ipBans.all() });
});

app.post("/api/admin/ipbans", requireAdmin, (req, res) => {
  const ip = String(req.body.ip || "").trim();
  const reason = String(req.body.reason || "").trim() || null;
  if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip)) return res.status(400).json({ error: "Geçersiz IP adresi" });
  if (q.ipBanByIp.get(ip)) return res.status(409).json({ error: "Bu IP zaten banlı" });
  q.addIpBan.run(ip, reason);
  audit(req.user.username, "ip-ban-add", ip);
  res.json({ ok: true });
});

app.delete("/api/admin/ipbans/:id", requireAdmin, (req, res) => {
  q.delIpBan.run(req.params.id);
  audit(req.user.username, "ip-ban-remove", req.params.id);
  res.json({ ok: true });
});

// ---- bakım modu ----
app.post("/api/admin/maintenance", requireAdmin, (req, res) => {
  const on = req.body.on ? 1 : 0;
  setSetting("maintenance", on);
  audit(req.user.username, "maintenance", on ? "açık" : "kapalı");
  res.json({ maintenance: !!on });
});

app.get("/api/admin/logs", requireAdmin, (req, res) => {
  res.json({ logs: q.logs.all() });
});

// ---- statik ----
// all.js artık zararsız bir stub (eski iframe-kırma kodu kaldırıldı).

// gamedistribution proxy (Snow Rider 3D icin - hile erisimi saglar)
const { createProxyMiddleware } = require("http-proxy-middleware");
app.use("/gd-proxy", createProxyMiddleware({
  target: "https://html5.gamedistribution.com",
  changeOrigin: true,
  pathRewrite: { "^/gd-proxy": "" },
  onProxyReq: (proxyReq) => {
    // Referrer'i gamedistribution olarak ayarla
    proxyReq.setHeader("Referer", "https://gamedistribution.com/");
    proxyReq.setHeader("Origin", "https://gamedistribution.com");
  },
  onProxyRes: (proxyRes) => {
    // X-Frame-Options ve CSP'yi kaldir (iframe icinde goster)
    delete proxyRes.headers["x-frame-options"];
    delete proxyRes.headers["content-security-policy"];
  },
  logLevel: "silent",
}));

app.use(express.static(ROOT, {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

// SPA fallback
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(ROOT, "index.html"));
});

app.listen(PORT, () => {
  console.log(`awzers: http://localhost:${PORT}`);
});
