// Общий код для страниц оплаты и аналитики.
(function () {
  const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const MONTHS_GEN = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  const util = {
    MONTHS,
    monthKey(d = new Date()) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); },
    shiftMonth(key, n) { const [y, m] = key.split("-").map(Number); return util.monthKey(new Date(y, m - 1 + n, 1)); },
    monthName(key) { const [y, m] = key.split("-").map(Number); return MONTHS[m - 1] + " " + y; },
    monthNameLower(key) { const [y, m] = key.split("-").map(Number); return MONTHS_GEN[m - 1] + " " + y; },
    digits(s) { return String(s || "").replace(/\D/g, "").slice(-10); },
    money(n) { return (Number(n) || 0).toLocaleString("ru-RU") + " ₸"; },
    esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
    norm(s) { return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); },
    date(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); },
    store: {
      get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    },
  };

  // Сжимаем фото перед отправкой: телефонные снимки весят 3–10 МБ.
  async function prepareFile(file) {
    if (file.type === "application/pdf") {
      if (file.size > 3 * 1024 * 1024) throw new Error("PDF больше 3 МБ — сделайте скриншот квитанции");
      return { name: file.name, type: file.type, data: await toBase64(file), preview: null };
    }
    try {
      const img = await loadImage(file);
      const max = 1600, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.82);
      return { name: file.name.replace(/\.\w+$/, "") + ".jpg", type: "image/jpeg", data: url.split(",")[1], preview: url };
    } catch (e) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Не получилось открыть файл. Загрузите фото (JPG, PNG) или PDF");
      if (file.size > 3 * 1024 * 1024) throw new Error("Файл больше 3 МБ — сделайте скриншот квитанции");
      return { name: file.name, type: file.type, data: await toBase64(file), preview: null };
    }
  }
  function loadImage(file) {
    return new Promise((ok, fail) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("image")); };
      img.src = url;
    });
  }
  function toBase64(file) {
    return new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => fail(new Error("Не удалось прочитать файл"));
      r.readAsDataURL(file);
    });
  }

  // Демо-режим: тот же API, но всё хранится в localStorage этого браузера.
  const demo = {
    load() { return util.store.get("md_demo") || { payments: [], children: [] }; },
    save(db) { if (!util.store.set("md_demo", db)) throw new Error("В демо-режиме закончилось место в браузере. Удалите старые квитанции."); },
    uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); },
    call(action, p) {
      const db = demo.load();
      if (action === "upload") {
        db.payments.push({
          id: demo.uid(), date: new Date().toISOString(), month: p.month || util.monthKey(), childId: "", amount: 0,
          file: "data:" + p.file.type + ";base64," + p.file.data, status: "Новая",
        });
        demo.save(db); return { ok: true };
      }
      if (action === "info") return { ok: true, bot: "" };
      if (!p.key) throw new Error("Введите пароль");
      if (action === "remind") return { ok: true, sent: 0 };
      if (action === "data") return { ok: true, payments: db.payments, children: db.children, parents: [], bot: "" };
      if (action === "review") {
        const x = db.payments.find(r => r.id === p.id);
        if (x) Object.assign(x, { status: p.status, childId: p.childId ?? x.childId, amount: Number(p.amount ?? x.amount) || 0, month: p.month || x.month });
        demo.save(db); return { ok: true };
      }
      if (action === "saveChild") {
        const c = p.child, i = db.children.findIndex(r => r.id === c.id);
        if (i >= 0) db.children[i] = c; else db.children.push({ ...c, id: demo.uid() });
        demo.save(db); return { ok: true };
      }
      if (action === "deleteChild") { db.children = db.children.filter(r => r.id !== p.id); demo.save(db); return { ok: true }; }
      if (action === "deletePayment") { db.payments = db.payments.filter(r => r.id !== p.id); demo.save(db); return { ok: true }; }
      throw new Error("Неизвестное действие");
    },
  };

  async function call(action, payload = {}) {
    if (!window.CONFIG.API_URL) return demo.call(action, payload);
    let res;
    try {
      // text/plain — чтобы браузер не делал preflight-запрос, который Apps Script не поддерживает
      res = await fetch(window.CONFIG.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action, ...payload }) });
    } catch (e) { throw new Error("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз."); }
    const j = await res.json().catch(() => ({ ok: false, error: "Сервер ответил с ошибкой" }));
    if (!j.ok) throw new Error(j.error || "Ошибка");
    return j;
  }

  // Файл квитанции для панели (приватный — только с паролем)
  async function fetchFile(key, id) {
    const res = await fetch(window.CONFIG.API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "file", key, id }) });
    if (!res.ok || /json/.test(res.headers.get("Content-Type") || "")) throw new Error("Не удалось открыть файл");
    return res.blob();
  }

  window.MD = { util, call, prepareFile, fetchFile, isDemo: () => !window.CONFIG.API_URL };
})();
