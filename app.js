/* ==========================================================
   awzers — istemci
   ========================================================== */
"use strict";

// ---------- durum ----------
const state = {
  user: null,
  games: [],
  filter: "all",
  search: "",
  currentGame: null,
  cheatsEnabled: {},
  maintenance: false,
};

// ---------- yardımcılar ----------
const $ = (id) => document.getElementById(id);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* boş */ }
  if (!res.ok) throw new Error(data.error || `Hata ${res.status}`);
  return data;
};

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- auth ekranı ----------
function showAuth() {
  $("auth-screen").classList.remove("hidden");
  $("app").classList.add("hidden");
}
function showApp() {
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
}

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("login-form").classList.toggle("hidden", which !== "login");
    $("register-form").classList.toggle("hidden", which !== "register");
    $("login-error").textContent = "";
    $("reg-error").textContent = "";
  });
});

document.querySelectorAll(".pass-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "gizle" : "göster";
  });
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("login-user").value.trim(), password: $("login-pass").value }),
    });
    state.user = data.user;
    await bootApp();
    toast(`Hoş geldin, ${data.user.username}!`);
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("reg-error").textContent = "";
  const pass = $("reg-pass").value;
  if (pass !== $("reg-pass2").value) {
    $("reg-error").textContent = "Şifreler eşleşmiyor";
    return;
  }
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: $("reg-user").value.trim(), password: pass }),
    });
    state.user = data.user;
    await bootApp();
    toast(`Hesap oluşturuldu — hoş geldin, ${data.user.username}!`);
  } catch (err) {
    $("reg-error").textContent = err.message;
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  showAuth();
  toast("Çıkış yapıldı");
});

// ---------- oyunlar ----------
const PAGE_SIZE = 60; // her seferde 60 oyun yükle
state.renderedCount = 0;

async function loadGames() {
  const data = await api("/api/games");
  state.games = data.games;
  state.renderedCount = 0;
  renderGames();
}

function filteredGames() {
  const q = state.search.trim().toLowerCase();
  return state.games.filter((g) => {
    if (g.hidden && state.user?.role !== "admin") return false;
    if (state.filter === "recommended" && !g.recommended) return false;
    if (q && !g.name.toLowerCase().includes(q) && !g.directory.toLowerCase().includes(q)) return false;
    return true;
  });
}

// Oyun kartı HTML'i
function gameCardHtml(g, i) {
  const imgPath = `/${g.directory}/${g.image}`;
  const badges = [];
  if (g.recommended) badges.push(`<span class="game-badge">Öneri</span>`);
  if (g.hidden) badges.push(`<span class="game-badge hidden-badge">Gizli</span>`);
  return `
    <div class="game-card" data-dir="${esc(g.directory)}" data-id="${g.id}" style="animation-delay:${Math.min((i % PAGE_SIZE) * 15, 400)}ms">
      <div class="game-thumb">
        <img src="${esc(imgPath)}" alt="" loading="lazy" onerror="this.style.display='none'">
        ${badges.join("")}
      </div>
      <div class="game-info">
        <div class="game-name">${esc(g.name)}</div>
        <div class="game-dir">/${esc(g.directory)}</div>
      </div>
    </div>`;
}

// Kart tıklama olaylarını bağla
function bindCardClicks(grid) {
  grid.querySelectorAll(".game-card:not([data-bound])").forEach((card) => {
    card.setAttribute("data-bound", "1");
    card.addEventListener("click", () => {
      const g = state.games.find((x) => x.id === Number(card.dataset.id));
      if (g) openGame(g);
    });
  });
}

function renderGames() {
  const list = filteredGames();
  const rec = list.filter((g) => g.recommended);

  // Öneriler en üstte (tümü)
  const recSection = $("recommended-section");
  const recGrid = $("recommended-grid");
  if (rec.length > 0) {
    recSection.classList.remove("hidden");
    recGrid.innerHTML = rec.map((g, i) => gameCardHtml(g, i)).join("");
    bindCardClicks(recGrid);
  } else {
    recSection.classList.add("hidden");
  }

  // Ana ızgara: arama/filtre varsa tüm liste, yoksa önerileri hariç tut
  const main = state.search.trim() || state.filter === "recommended"
    ? list
    : list.filter((g) => !g.recommended);

  // Lazy load: sadece ilk PAGE_SIZE kartı render et
  state._mainList = main;
  state.renderedCount = Math.min(PAGE_SIZE, main.length);
  const grid = $("games-grid");
  grid.innerHTML = main.slice(0, state.renderedCount).map((g, i) => gameCardHtml(g, i)).join("");
  bindCardClicks(grid);

  $("games-empty").classList.toggle("hidden", main.length > 0 || rec.length > 0);
  updateLoadMoreBtn();
}

// Daha fazla oyun yükle
function loadMoreGames() {
  const main = state._mainList || [];
  if (state.renderedCount >= main.length) return;
  const next = Math.min(state.renderedCount + PAGE_SIZE, main.length);
  const grid = $("games-grid");
  grid.insertAdjacentHTML("beforeend", main.slice(state.renderedCount, next).map((g, i) => gameCardHtml(g, i + state.renderedCount)).join(""));
  state.renderedCount = next;
  bindCardClicks(grid);
  updateLoadMoreBtn();
}

function updateLoadMoreBtn() {
  const main = state._mainList || [];
  const btn = $("load-more-btn");
  if (!btn) return;
  if (state.renderedCount < main.length) {
    btn.classList.remove("hidden");
    btn.textContent = `Daha Fazla Yükle (${main.length - state.renderedCount} oyun daha)`;
  } else {
    btn.classList.add("hidden");
  }
}

// Scroll ile otomatik yükleme (infinite scroll)
let scrollLoading = false;
function setupInfiniteScroll() {
  const main = $("main");
  if (!main) return; // element henüz yoksa sessizce geç
  main.addEventListener("scroll", () => {
    if (scrollLoading) return;
    const rect = main.getBoundingClientRect();
    const scrollBottom = rect.bottom;
    if (scrollBottom < window.innerHeight + 400) {
      scrollLoading = true;
      loadMoreGames();
      setTimeout(() => { scrollLoading = false; }, 200);
    }
  });
}

$("game-search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderGames();
});

$("filter-row").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#filter-row .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  state.filter = chip.dataset.filter;
  renderGames();
});

// ---------- oyun modalı ----------
function openGame(g) {
  state.currentGame = g;
  $("modal-title").textContent = g.name;
  $("game-modal").classList.remove("hidden");
  $("game-frame").src = `/${g.directory}/index.html`;
  api(`/api/games/${g.id}/play`, { method: "POST" }).catch(() => {});

  // Modal boyutunu ekrana göre ayarla (tam ekran)
  const modal = $("game-modal").querySelector(".modal-content");
  if (modal) {
    modal.style.width = "100vw";
    modal.style.height = "100vh";
    modal.style.maxWidth = "100vw";
    modal.style.maxHeight = "100vh";
    modal.style.borderRadius = "0";
  }
  $("game-frame").style.width = "100%";
  $("game-frame").style.height = "100%";

  // SADECE admin hileleri görür
  if (state.user && state.user.role === "admin") {
    buildCheatPanel(g);
    $("cheat-panel").style.display = "block";
    $("cheat-panel").classList.remove("hidden");
  } else {
    $("cheat-panel").style.display = "none";
    $("cheat-panel").classList.add("hidden");
  }
}

function closeGame() {
  $("game-modal").classList.add("hidden");
  $("game-frame").src = "about:blank";
  $("cheat-panel").style.display = "none";
  $("cheat-panel").classList.add("hidden");
  state.currentGame = null;
}

$("modal-close").addEventListener("click", closeGame);
$("modal-backdrop").addEventListener("click", closeGame);
$("modal-fullscreen").addEventListener("click", () => {
  const el = $("game-frame");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("game-modal").classList.contains("hidden")) closeGame();
});

// ==========================================================
// HİLE SİSTEMİ (sadece admin)
// ==========================================================
const CHEATS = {
  _global: [
    { id: "slowmo", label: "Yavaş Çekim", run: () => applyGlobalCheat("slowmo") },
    { id: "speedup", label: "Hızlandır", run: () => applyGlobalCheat("speedup") },
    { id: "freeze", label: "Zamanı Dondur", run: () => applyGlobalCheat("freeze") },
    { id: "mute", label: "Sesi Kapat", run: () => applyGlobalCheat("mute") },
    { id: "unlimited-time", label: "Süreyi Dondur", run: () => applyGlobalCheat("unlimited-time") },
  ],
  snowrider3d: [
    { id: "snow-invincible", label: "Ölümsüzlük", run: () => snowCheat("invincible") },
    { id: "snow-score", label: "Skor 999999", run: () => snowCheat("score") },
    { id: "snow-speed", label: "Süper Hız", run: () => snowCheat("speed") },
    { id: "snow-slow", label: "Ağır Çekim", run: () => snowCheat("slow") },
    { id: "snow-noclip", label: "Duvardan Geç", run: () => snowCheat("noclip") },
    { id: "snow-freeze", label: "Engelleri Dondur", run: () => snowCheat("freeze") },
  ],
  slope: [
    { id: "slope-god", label: "Ölümsüzlük", run: () => injectScript("try{window.gameSpeed=1}catch(e){}") },
  ],
  run: [
    { id: "run-god", label: "Ölümsüzlük", run: () => injectScript("try{game.player.godmode=true}catch(e){}") },
  ],
};

// Snow Rider 3D'a özel hileler (canvas/runtime müdahalesi — obje adı gerektirmez)
function snowCheat(kind) {
  const f = $("game-frame");
  const w = f.contentWindow;
  if (!w) return toast("Oyun yüklenmedi");

  try {
    const unity = w.gameInstance?.Module || w.Module;
    if (!unity) return toast("Unity bağlantısı yok");

    switch (kind) {
      case "invincible":
        // Unity'nin çarpışma/fizik sistemini hook'la
        w.eval(`
          window.__snowGod = true;
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            // Tüm bilinen obje/metod kombinasyonlarını dene
            const objs = ['GameController','GameManager','Player','PlayerController','UIManager'];
            const methods = ['SetInvincible','SetGodMode','SetHealth','SetCollisionEnabled','SetColliderEnabled'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '1'); } catch(e) {}
              try { mod.SendMessage(obj, m, '999999'); } catch(e) {}
              try { mod.SendMessage(obj, m, '0'); } catch(e) {}
            }));
          }
          // requestAnimationFrame'i yavaşlat (çarpışma hasarını azalt)
          if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => window.__origRAF((t) => cb(t * 0.5));
        `);
        toast("Ölümsüzlük açık ✓ (tüm kombinasyonlar gönderildi)");
        break;

      case "score":
        w.eval(`
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            const objs = ['GameController','GameManager','Player','ScoreManager','UIManager','GameController'];
            const methods = ['AddScore','SetScore','UpdateScore','AddPoints','SetPoints'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '999999'); } catch(e) {}
              try { mod.SendMessage(obj, m, '999999.0'); } catch(e) {}
            }));
            // Bellekteki skor değişkenlerini ara ve değiştir
            if (mod.HEAPF32) {
              const heap = mod.HEAPF32;
              for (let i = 0; i < Math.min(heap.length, 2000000); i++) {
                const v = heap[i];
                // Skor benzeri tam sayı değerleri (100-100000 arası, 10'a bölünen)
                if (Number.isInteger(v) && v > 100 && v < 100000 && v % 10 === 0) {
                  heap[i] = 999999;
                }
              }
            }
          }
        `);
        toast("Skor 999999 gönderildi ✓ (bellekte de arandı)");
        break;

      case "speed":
        w.eval(`
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            const objs = ['GameController','GameManager','Player','PlayerController'];
            const methods = ['SetSpeed','SetSpeedMultiplier','SetGameSpeed','SetTimeScale'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '3'); } catch(e) {}
              try { mod.SendMessage(obj, m, '3.0'); } catch(e) {}
              try { mod.SendMessage(obj, m, '5'); } catch(e) {}
            }));
          }
          // Zamanı hızlandır
          if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => window.__origRAF((t) => cb(t * 2));
        `);
        toast("Süper hız açık ✓");
        break;

      case "slow":
        w.eval(`
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            const objs = ['GameController','GameManager','Player','PlayerController'];
            const methods = ['SetSpeed','SetSpeedMultiplier','SetGameSpeed','SetTimeScale'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '0.3'); } catch(e) {}
              try { mod.SendMessage(obj, m, '0.3f'); } catch(e) {}
            }));
          }
          // Zamanı yavaşlat
          if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => window.__origRAF((t) => cb(t * 0.3));
        `);
        toast("Ağır çekim açık ✓");
        break;

      case "noclip":
        w.eval(`
          window.__snowNoclip = true;
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            const objs = ['GameController','GameManager','Player','PlayerController'];
            const methods = ['SetCollisionEnabled','SetColliderEnabled','SetIgnoreCollision','SetInvincible'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '0'); } catch(e) {}
              try { mod.SendMessage(obj, m, 'false'); } catch(e) {}
            }));
          }
        `);
        toast("Duvardan geçme açık ✓");
        break;

      case "freeze":
        w.eval(`
          window.__snowFreeze = true;
          if (window.gameInstance?.Module) {
            const mod = window.gameInstance.Module;
            const objs = ['GameController','GameManager','ObstacleManager','Spawner','ObstacleSpawner'];
            const methods = ['SetSpawnEnabled','SetEnabled','SetObstacleSpeed','SetSpawnRate','SetActive'];
            objs.forEach(obj => methods.forEach(m => {
              try { mod.SendMessage(obj, m, '0'); } catch(e) {}
              try { mod.SendMessage(obj, m, 'false'); } catch(e) {}
            }));
          }
          // Zamanı dondur
          if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
          window.requestAnimationFrame = () => {};
        `);
        toast("Engeller donduruldu ✓");
        break;
    }
  } catch (e) {
    toast("Hile hatası: " + e.message);
  }
}

// Unity WebGL oyunlarına SendMessage ile hile gönder
function sendToGame(method, value) {
  try {
    const f = $("game-frame");
    const w = f.contentWindow;
    if (!w) return toast("Oyun yüklenmedi");
    // Unity gameInstance üzerinden gönder
    if (w.gameInstance && w.gameInstance.SendMessage) {
      w.gameInstance.SendMessage("GameManager", method, value);
      toast(`${method} gönderildi ✓`);
      return true;
    }
    // Eski Unity API
    if (w.SendMessage) {
      w.SendMessage("GameManager", method, value);
      toast(`${method} gönderildi ✓`);
      return true;
    }
    toast("Bu oyun Unity bağlantısını desteklemiyor");
    return false;
  } catch (e) {
    toast("Hile uygulanamadı: " + e.message);
    return false;
  }
}

// Genel JS enjeksiyonu (DOM/JS oyunları için)
function injectScript(code) {
  try {
    const f = $("game-frame");
    if (!f.contentWindow) return toast("Oyun yüklenmedi");
    f.contentWindow.eval(code);
    toast("Hile uygulandı ✓");
    return true;
  } catch (e) {
    toast("Hile uygulanamadı: " + e.message);
    return false;
  }
}

// Genel hileler (tüm oyunlarda denenir)
function applyGlobalCheat(kind) {
  const f = $("game-frame");
  const w = f.contentWindow;
  if (!w) return toast("Oyun yüklenmedi");
  const toggle = !state.cheatsEnabled[kind];
  state.cheatsEnabled[kind] = toggle;
  try {
    if (kind === "slowmo") {
      w.eval(`
        if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = ${toggle ? "(cb) => window.__origRAF((t) => cb(t * 0.3))" : "window.__origRAF"};
      `);
    } else if (kind === "speedup") {
      w.eval(`
        if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = ${toggle ? "(cb) => window.__origRAF((t) => cb(t * 3))" : "window.__origRAF"};
      `);
    } else if (kind === "freeze") {
      w.eval(`
        if (!window.__origRAF) window.__origRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = ${toggle ? "() => {}" : "window.__origRAF"};
      `);
    } else if (kind === "mute") {
      w.eval(`
        document.querySelectorAll('audio,video').forEach(a => a.muted = ${toggle});
        if (${toggle}) { window.__origAudioCtx = window.AudioContext; window.AudioContext = function(){ return { createGain: () => ({connect(){},gain:{value:0}}), createOscillator: () => ({connect(){},start(){},stop(){},frequency:{value:0}}), destination: {}, currentTime: 0, state: 'running', resume(){} }; }; }
        else if (window.__origAudioCtx) window.AudioContext = window.__origAudioCtx;
      `);
    } else if (kind === "unlimited-time") {
      // Süre sayaçlarını durdur (setInterval/clearInterval hook)
      w.eval(`
        if (${toggle}) {
          window.__origSI = window.setInterval;
          window.setInterval = function() { return 0; };
        } else if (window.__origSI) {
          window.setInterval = window.__origSI;
        }
      `);
    }
  } catch (e) {
    toast("Hile uygulanamadı: " + e.message);
    return;
  }
  toast(`${kind} ${toggle ? "açık ✓" : "kapalı"}`);
  buildCheatPanel(state.currentGame);
}

function buildCheatPanel(g) {
  const list = $("cheat-list");
  $("cheat-game-name").textContent = `Oyun: ${g.name}`;
  $("cheat-body").classList.remove("hidden");
  $("cheat-min").textContent = "–";
  $("cheat-panel").style.display = "block";
  $("cheat-panel").classList.remove("hidden");

  const items = [
    ...CHEATS._global.map((c) => ({ ...c, on: !!state.cheatsEnabled[c.id] })),
    ...(CHEATS[g.directory] || []).map((c) => ({ ...c, on: false })),
  ];

  list.innerHTML = items.map((c) => `
    <div class="cheat-item">
      <span>${esc(c.label)}</span>
      <button data-cheat="${esc(c.id)}" class="${c.on ? "on" : "off"}">${c.on ? "Açık" : "Uygula"}</button>
    </div>`).join("");

  list.querySelectorAll("button[data-cheat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cheat = items.find((c) => c.id === btn.dataset.cheat);
      if (cheat) cheat.run();
    });
  });
}

$("cheat-close").addEventListener("click", () => {
  $("cheat-panel").style.display = "none";
  $("cheat-panel").classList.add("hidden");
});
$("cheat-min").addEventListener("click", () => {
  const body = $("cheat-body");
  const hidden = body.classList.toggle("hidden");
  $("cheat-min").textContent = hidden ? "+" : "–";
});

// Cheat paneli sürükleme
(() => {
  const panel = $("cheat-panel");
  const head = $("cheat-drag");
  let dragging = false, ox = 0, oy = 0;
  head.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox)) + "px";
    panel.style.top = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - oy)) + "px";
    panel.style.right = "auto";
  });
  document.addEventListener("mouseup", () => { dragging = false; });
})();

// ==========================================================
// ADMİN PANEL
// ==========================================================
$("admin-btn").addEventListener("click", async () => {
  $("admin-panel").classList.remove("hidden");
  await refreshAdmin();
});
$("admin-close").addEventListener("click", () => $("admin-panel").classList.add("hidden"));
$("admin-backdrop").addEventListener("click", () => $("admin-panel").classList.add("hidden"));

document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".admin-page").forEach((p) => p.classList.add("hidden"));
    document.querySelector(`[data-apage="${tab.dataset.atab}"]`).classList.remove("hidden");
    refreshAdmin();
  });
});

async function refreshAdmin() {
  if (state.user?.role !== "admin") return;
  try {
    const stats = await api("/api/admin/stats");
    $("stat-cards").innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.users}</div><div class="stat-label">Kullanıcı</div></div>
      <div class="stat-card"><div class="stat-value">${stats.admins}</div><div class="stat-label">Admin</div></div>
      <div class="stat-card"><div class="stat-value">${stats.games}</div><div class="stat-label">Oyun</div></div>
      <div class="stat-card"><div class="stat-value">${stats.hidden_games}</div><div class="stat-label">Gizli</div></div>
      <div class="stat-card"><div class="stat-value">${stats.plays}</div><div class="stat-label">Oynama</div></div>
      <div class="stat-card"><div class="stat-value">${stats.ip_bans}</div><div class="stat-label">IP Ban</div></div>`;

    // Kullanıcılar
    const users = (await api("/api/admin/users")).users;
    $("users-table").querySelector("tbody").innerHTML = users.map((u) => `
      <tr>
        <td>${u.id}</td>
        <td><strong>${esc(u.username)}</strong></td>
        <td><span class="badge badge-${u.role}">${u.role}</span></td>
        <td>${u.banned ? '<span class="badge badge-banned">Yasaklı</span>' : '<span class="badge badge-ok">Aktif</span>'}</td>
        <td>${u.last_login ? esc(u.last_login) : "—"}</td>
        <td><div class="row-actions">
          ${u.username === "0000" ? '<span style="color:var(--text-dim);font-size:12px">korumalı</span>' : `
          <button class="btn btn-sm btn-ghost" data-act="toggle-role" data-id="${u.id}">${u.role === "admin" ? "User yap" : "Admin yap"}</button>
          ${u.banned
            ? `<button class="btn btn-sm btn-ghost" data-act="toggle-ban" data-id="${u.id}">Ban kaldır</button>`
            : `<button class="btn btn-sm btn-danger" data-act="ban-with-ip" data-id="${u.id}">Ban + IP Ban</button>`
          }
          <button class="btn btn-sm btn-danger" data-act="del-user" data-id="${u.id}">Sil</button>`}
        </div></td>
      </tr>`).join("");

    // Oyunlar
    const games = (await api("/api/games")).games;
    $("games-table").querySelector("tbody").innerHTML = games.map((g) => `
      <tr>
        <td>${g.id}</td>
        <td><strong>${esc(g.name)}</strong></td>
        <td>/<code>${esc(g.directory)}</code></td>
        <td>${g.recommended ? '<span class="badge badge-ok">Evet</span>' : "—"}</td>
        <td>${g.hidden ? '<span class="badge badge-hidden">Gizli</span>' : "—"}</td>
        <td><div class="row-actions">
          <button class="btn btn-sm btn-ghost" data-act="toggle-rec" data-id="${g.id}">${g.recommended ? "Öneri kaldır" : "Öner"}</button>
          <button class="btn btn-sm btn-ghost" data-act="toggle-hidden" data-id="${g.id}">${g.hidden ? "Göster" : "Gizle"}</button>
          <button class="btn btn-sm btn-danger" data-act="del-game" data-id="${g.id}">Sil</button>
        </div></td>
      </tr>`).join("");

    // IP banlar
    const ipbans = (await api("/api/admin/ipbans")).ipbans;
    $("ipbans-table").querySelector("tbody").innerHTML = ipbans.length === 0
      ? '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">Banlı IP yok</td></tr>'
      : ipbans.map((b) => `
      <tr>
        <td>${b.id}</td>
        <td><code>${esc(b.ip)}</code></td>
        <td>${esc(b.reason || "—")}</td>
        <td>${esc(b.created_at)}</td>
        <td><button class="btn btn-sm btn-ghost" data-act="del-ipban" data-id="${b.id}">Kaldır</button></td>
      </tr>`).join("");

    // Loglar
    const logs = (await api("/api/admin/logs")).logs;
    $("logs-table").querySelector("tbody").innerHTML = logs.map((l) => `
      <tr>
        <td style="white-space:nowrap">${esc(l.created_at)}</td>
        <td><strong>${esc(l.actor)}</strong></td>
        <td><code>${esc(l.action)}</code></td>
        <td>${esc(l.target || "—")}</td>
      </tr>`).join("");

    bindAdminActions();
  } catch (err) {
    toast("Admin verisi alınamadı: " + err.message);
  }
}

function bindAdminActions() {
  document.querySelectorAll("[data-act]").forEach((btn) => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const id = Number(btn.dataset.id);
      try {
        if (act === "toggle-role") {
          const user = (await api("/api/admin/users")).users.find((u) => u.id === id);
          await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role: user.role === "admin" ? "user" : "admin" }) });
        } else if (act === "toggle-ban") {
          const user = (await api("/api/admin/users")).users.find((u) => u.id === id);
          await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ banned: !user.banned }) });
        } else if (act === "ban-with-ip") {
          if (!confirm("Kullanıcıyı banla ve son IP'sini de banla?")) return;
          const res = await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ banned: true, ipBan: true }) });
          toast(res.bannedIp ? `Kullanıcı banlandı + IP banlandı (${res.bannedIp})` : "Kullanıcı banlandı (IP bulunamadı)");
        } else if (act === "del-user") {
          if (!confirm("Kullanıcıyı silmek istediğine emin misin?")) return;
          await api(`/api/admin/users/${id}`, { method: "DELETE" });
        } else if (act === "del-game") {
          if (!confirm("Oyunu listeden silmek istediğine emin misin?")) return;
          await api(`/api/games/${id}`, { method: "DELETE" });
          await loadGames();
        } else if (act === "toggle-rec") {
          const g = (await api("/api/games")).games.find((x) => x.id === id);
          await api(`/api/games/${id}`, { method: "PATCH", body: JSON.stringify({ name: g.name, recommended: !g.recommended, hidden: g.hidden }) });
        } else if (act === "toggle-hidden") {
          const g = (await api("/api/games")).games.find((x) => x.id === id);
          await api(`/api/games/${id}`, { method: "PATCH", body: JSON.stringify({ name: g.name, recommended: g.recommended, hidden: !g.hidden }) });
          await loadGames();
        } else if (act === "del-ipban") {
          await api(`/api/admin/ipbans/${id}`, { method: "DELETE" });
        }
        toast("İşlem tamamlandı");
        await refreshAdmin();
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

$("user-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: $("new-username").value.trim(), password: $("new-password").value, role: $("new-role").value }),
    });
    $("new-username").value = "";
    $("new-password").value = "";
    toast("Kullanıcı eklendi");
    await refreshAdmin();
  } catch (err) {
    toast(err.message);
  }
});

$("game-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/games", {
      method: "POST",
      body: JSON.stringify({
        name: $("new-game-name").value.trim(),
        directory: $("new-game-dir").value.trim(),
        image: $("new-game-img").value.trim() || "cover.svg",
        recommended: $("new-game-rec").checked,
      }),
    });
    $("new-game-name").value = "";
    $("new-game-dir").value = "";
    $("new-game-img").value = "";
    $("new-game-rec").checked = false;
    toast("Oyun eklendi");
    await loadGames();
    await refreshAdmin();
  } catch (err) {
    toast(err.message);
  }
});

$("ipban-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/ipbans", {
      method: "POST",
      body: JSON.stringify({ ip: $("new-ipban-ip").value.trim(), reason: $("new-ipban-reason").value.trim() }),
    });
    $("new-ipban-ip").value = "";
    $("new-ipban-reason").value = "";
    toast("IP banlandı");
    await refreshAdmin();
  } catch (err) {
    toast(err.message);
  }
});

// Bakım modu
$("maintenance-toggle").addEventListener("click", async () => {
  try {
    const on = !state.maintenance;
    await api("/api/admin/maintenance", { method: "POST", body: JSON.stringify({ on }) });
    state.maintenance = on;
    updateMaintenanceBtn();
    toast(on ? "Bakım modu AÇIK — herkes bakım ekranı görüyor" : "Bakım modu KAPALI");
  } catch (err) {
    toast(err.message);
  }
});

function updateMaintenanceBtn() {
  const btn = $("maintenance-toggle");
  if (state.maintenance) {
    btn.textContent = "Bakım Modunu Kapat";
    btn.className = "btn btn-success";
  } else {
    btn.textContent = "Bakım Modunu Aç";
    btn.className = "btn btn-danger";
  }
}

// ---------- başlatma ----------
async function bootApp() {
  showApp();
  const u = state.user;
  $("user-name").textContent = u.username;
  $("user-role").textContent = u.role;
  $("user-role").classList.toggle("admin", u.role === "admin");
  $("user-avatar").textContent = u.username.charAt(0).toUpperCase();
  $("user-avatar").style.background = `linear-gradient(135deg, ${u.avatar_color}, var(--accent-2))`;
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", u.role !== "admin"));
  setupInfiniteScroll();
  await loadGames();
}

(async function init() {
  try {
    const data = await api("/api/auth/me");
    if (data.user) {
      state.user = data.user;
      state.maintenance = !!data.maintenance;
      await bootApp();
      if (data.maintenance) updateMaintenanceBtn();
    } else {
      showAuth();
    }
  } catch (err) {
    showAuth();
  }
})();
