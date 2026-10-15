/**
 * Сервер «Мир детства»: страницы оплаты на сайте + Telegram-бот для квитанций.
 * Вставляется в Google Таблицу: Расширения → Apps Script. Инструкция — НАСТРОЙКА-ОПЛАТ.md.
 *
 * Квитанции сохраняются в папку Google Диска владельца таблицы,
 * строки — на листы «Оплаты», «Дети» и «Родители (Telegram)».
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   ADMIN_KEY    — пароль для admin.html и команды /admin в боте
 *   BOT_TOKEN    — токен бота от @BotFather
 *   WEB_APP_URL  — ссылка веб-приложения (…/exec)
 *   SITE_URL     — адрес сайта, например https://mirdetstva.kz/ (необязательно)
 * TG_SECRET, BOT_USERNAME, FOLDER_ID, ADMIN_CHATS заполняются сами.
 */

// Можно вписать настройки прямо сюда (скрипт приватный) — тогда «Свойства скрипта» не нужны.
const SETTINGS = {
  SHEET_ID: "",   // id таблицы, если скрипт создан отдельно от неё
  ADMIN_KEY: "",
  BOT_TOKEN: "",
  SITE_URL: "",
};

const PAYMENTS = "Оплаты";
const CHILDREN = "Дети";
const PARENTS = "Родители (Telegram)";
const FOLDER_NAME = "Квитанции — Мир детства";
const P_HEAD = ["id", "Дата", "Месяц", "Ребёнок", "Сумма", "Файл", "Статус", "id ребёнка", "Telegram", "tg_file"];
const C_HEAD = ["id", "Ребёнок", "Родитель", "Телефон", "Группа", "Сумма в месяц"];
const R_HEAD = ["chat_id", "Имя", "Телефон", "Ребёнок (со слов)", "Username", "Дата"];
const STATUSES = ["Новая", "Подтверждена", "Отклонена"];
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
const TZ = "Asia/Almaty";
const WHATSAPP = "77772829292";
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

// Первое открытие ссылки веб-приложения показывает форму запуска бота
function doGet() {
  if (prop("SETUP_DONE")) return json({ ok: true, service: "mir-detstva-payments" });
  return HtmlService.createHtmlOutput(SETUP_PAGE).setTitle("Запуск бота").addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// Вызывается из формы запуска (google.script.run)
function completeSetup(token, password) {
  if (prop("SETUP_DONE")) throw new Error("Бот уже запущен");
  token = String(token || "").trim(); password = String(password || "").trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error("Проверьте токен — его выдаёт @BotFather");
  if (password.length < 8) throw new Error("Пароль — минимум 8 символов");
  const props = PropertiesService.getScriptProperties();
  props.setProperty("BOT_TOKEN", token);
  props.setProperty("ADMIN_KEY", password);
  return setup();
}

const SETUP_PAGE = '<style>body{font:17px -apple-system,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1f2b4d}' +
  'h1{font-size:24px}input{font:inherit;width:100%;box-sizing:border-box;padding:14px;border:1.5px solid #ccd;border-radius:12px;margin:6px 0 16px}' +
  'button{font:inherit;font-weight:700;width:100%;padding:16px;border:0;border-radius:14px;background:#e23a7a;color:#fff}label{font-size:14px;color:#5f6782}#msg{margin-top:16px}</style>' +
  '<h1>Запуск бота «Мир детства»</h1>' +
  '<label>Токен бота (из @BotFather)</label><input id="t" autocomplete="off">' +
  '<label>Придумайте пароль для садика</label><input id="p" type="password" autocomplete="new-password">' +
  '<button id="b" onclick="go()">Запустить</button><div id="msg"></div>' +
  '<script>function go(){var b=document.getElementById("b"),m=document.getElementById("msg");b.disabled=true;m.textContent="Запускаем…";' +
  'google.script.run.withSuccessHandler(function(u){m.innerHTML="✅ Бот <b>@"+u+"</b> запущен! Можно закрывать страницу.";b.style.display="none"})' +
  '.withFailureHandler(function(e){m.textContent="⚠️ "+e.message;b.disabled=false}).completeSetup(document.getElementById("t").value,document.getElementById("p").value)}</script>';

function doPost(e) {
  // Запросы от Telegram приходят с ?tg=<секрет>
  if (e.parameter && e.parameter.tg !== undefined) {
    handleTelegram(e);
    return ContentService.createTextOutput("ok");
  }
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.action === "upload") return json(upload(req));
    if (req.action === "info") return json({ ok: true, bot: prop("BOT_USERNAME") || "" });
    checkKey(req.key);
    switch (req.action) {
      case "data": return json(data());
      case "review": return json(review(req));
      case "saveChild": return json(saveChild(req.child || {}));
      case "deleteChild": return json(deleteRow(CHILDREN, req.id));
      case "remind": return json(remindMany(req.childIds || [], req.month));
    }
    throw new Error("Неизвестное действие");
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

// =================== сайт ===================

function upload(r) {
  if (!r.file || !r.file.data) throw new Error("Приложите квитанцию");
  const ext = TYPES[r.file.type];
  if (!ext) throw new Error("Загрузите фото (JPG, PNG) или PDF");
  const bytes = Utilities.base64Decode(r.file.data);
  if (bytes.length > MAX_BYTES) throw new Error("Файл больше 8 МБ");
  const month = /^\d{4}-\d{2}$/.test(r.month) ? r.month : thisMonth();
  const url = saveFile(Utilities.newBlob(bytes, r.file.type, fileName(month, ext)));
  addPayment({ month: month, file: url });
  return { ok: true };
}

function data() {
  const payments = rows(PAYMENTS, P_HEAD).map(function (r) {
    return {
      id: String(r[0]), date: r[1] instanceof Date ? r[1].toISOString() : String(r[1]), month: String(r[2]),
      amount: Number(r[4]) || 0, file: String(r[5]), status: String(r[6] || "Новая"), childId: String(r[7] || ""),
      chat: String(r[8] || ""),
    };
  });
  const children = kids().map(function (k) {
    return { id: k.id, name: k.name, parent: k.parent, phone: k.phone, group: k.group, fee: k.fee };
  });
  const parents = rows(PARENTS, R_HEAD).map(function (r) {
    return { chat: String(r[0]), name: String(r[1]), phone: String(r[2]), childName: String(r[3]), username: String(r[4]), date: r[5] instanceof Date ? r[5].toISOString() : "" };
  });
  return { ok: true, payments: payments, children: children, parents: parents, bot: prop("BOT_USERNAME") || "" };
}

// Садик отмечает, чей платёж, сумму и статус. Родителю из Telegram приходит уведомление.
function review(r) {
  if (STATUSES.indexOf(r.status) < 0) throw new Error("Неверный статус");
  if (r.month && !/^\d{4}-\d{2}$/.test(r.month)) throw new Error("Неверный месяц");
  let before, after;
  withLock(function () {
    const sh = sheet(PAYMENTS, P_HEAD), row = findRow(sh, r.id);
    if (!row) throw new Error("Квитанция не найдена");
    const cur = sh.getRange(row, 1, 1, P_HEAD.length).getValues()[0];
    let childName = cur[3], childId = cur[7];
    if (r.childId !== undefined) {
      childId = String(r.childId || "");
      const kid = kidById(childId);
      childName = kid ? safe(kid.name, 100) : "";
    }
    const month = r.month || String(cur[2]);
    const amount = r.amount !== undefined ? Math.max(0, Math.round(Number(r.amount) || 0)) || "" : cur[4];
    sh.getRange(row, 3, 1, 6).setValues([["'" + month, childName, amount, cur[5], r.status, childId]]);
    before = String(cur[6]);
    after = { chat: cur[8], childId: childId, month: month, amount: amount, status: r.status };
  });
  if (after.chat && before !== after.status && after.status !== "Новая") notifyParent(after);
  return { ok: true };
}

function saveChild(c) {
  if (!c.name) throw new Error("Укажите имя ребёнка");
  const values = [safe(c.name, 100), safe(c.parent, 100), "'" + digits(c.phone), safe(c.group, 50), Math.max(0, Number(c.fee) || 0) || ""];
  withLock(function () {
    const sh = sheet(CHILDREN, C_HEAD), row = c.id ? findRow(sh, c.id) : 0;
    if (row) sh.getRange(row, 2, 1, values.length).setValues([values]);
    else sh.appendRow([Utilities.getUuid()].concat(values));
  });
  return { ok: true };
}

function deleteRow(name, id) {
  withLock(function () {
    const sh = sheet(name, name === CHILDREN ? C_HEAD : P_HEAD), row = findRow(sh, id);
    if (row) sh.deleteRow(row);
  });
  return { ok: true };
}

// =================== Telegram-бот ===================

const MAIN_KB = { keyboard: [[{ text: "📊 Мой статус" }, { text: "❓ Помощь" }]], resize_keyboard: true };
const PHONE_KB = { keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

function handleTelegram(e) {
  if (!prop("TG_SECRET") || e.parameter.tg !== prop("TG_SECRET")) return;
  let u;
  try { u = JSON.parse(e.postData.contents); } catch (x) { return; }
  // Telegram может прислать одно и то же обновление повторно — обрабатываем один раз
  const cache = CacheService.getScriptCache(), key = "u" + u.update_id;
  if (cache.get(key)) return;
  cache.put(key, "1", 21600);
  try {
    if (u.message) onMessage(u.message);
    else if (u.callback_query) onCallback(u.callback_query);
  } catch (err) {
    console.error(err);
  }
}

function onMessage(m) {
  if (!m.chat || m.chat.type !== "private") return;
  const chat = m.chat.id, text = String(m.text || "").trim();

  if (text === "/admin_off") return adminLogout(chat);
  if (/^\/admin\b/.test(text)) return adminLogin(m, text.split(/\s+/)[1] || "");

  const parent = parentByChat(chat);

  if (m.contact) {
    if (m.contact.user_id !== m.from.id) return send(chat, "Пожалуйста, отправьте <b>свой</b> номер кнопкой ниже 👇", { reply_markup: PHONE_KB });
    return register(m, m.contact.phone_number);
  }

  if (!parent) {
    return send(chat,
      "Здравствуйте! 👋 Это бот детского сада <b>«Мир детства»</b>.\n\n" +
      "Здесь можно отправлять квитанции об оплате и получать уведомления, когда оплату подтвердят.\n\n" +
      "Чтобы начать, поделитесь номером телефона — по нему мы найдём вашего ребёнка.",
      { reply_markup: PHONE_KB });
  }

  const cache = CacheService.getScriptCache();
  if (cache.get("st" + chat) === "child" && text && text[0] !== "/" && !m.photo && !m.document) {
    setParentChild(chat, text);
    cache.remove("st" + chat);
    return send(chat, "Спасибо! Записали: <b>" + h(text) + "</b>.\n\nТеперь просто отправляйте сюда фото или скриншот квитанции 🧾", { reply_markup: MAIN_KB });
  }

  if (m.photo || m.document) return onReceipt(m, parent);
  if (text === "/start") return send(chat, "С возвращением, " + h(parent.name) + "! Отправьте фото или скриншот квитанции — я передам её в садик 🧾", { reply_markup: MAIN_KB });
  if (text === "📊 Мой статус" || text === "/status") return send(chat, statusText(parent), { reply_markup: MAIN_KB });
  if (text === "❓ Помощь" || text === "/help") return send(chat, helpText(), { reply_markup: MAIN_KB });
  return send(chat, "Отправьте фото, скриншот или PDF квитанции — я передам её в садик 🧾", { reply_markup: MAIN_KB });
}

function register(m, phoneRaw) {
  const chat = m.chat.id, phone = digits(phoneRaw);
  const name = text([m.from.first_name, m.from.last_name].filter(Boolean).join(" "), 100);
  withLock(function () {
    const sh = sheet(PARENTS, R_HEAD), row = findRow(sh, chat);
    const values = [String(chat), safe(name, 100), "'" + phone, row ? sh.getRange(row, 4).getValue() : "", safe(m.from.username || "", 64), new Date()];
    if (row) sh.getRange(row, 1, 1, values.length).setValues([values]);
    else sh.appendRow(values);
  });
  const mine = kidsByPhone(phone);
  if (mine.length) {
    return send(chat,
      "Готово, " + h(name) + "! ✅\n\nНашли: " + mine.map(function (k) { return "<b>" + h(k.name) + "</b>" + (k.group ? " (" + h(k.group) + ")" : ""); }).join(", ") + ".\n\n" +
      "Теперь просто отправляйте сюда фото или скриншот квитанции 🧾\nКогда садик подтвердит оплату, я пришлю уведомление.",
      { reply_markup: MAIN_KB });
  }
  CacheService.getScriptCache().put("st" + chat, "child", 21600);
  return send(chat, "Номер сохранён ✅\n\nНапишите, пожалуйста, <b>имя и фамилию ребёнка</b> — чтобы садик понял, чьи квитанции.", { reply_markup: { remove_keyboard: true } });
}

function onReceipt(m, parent) {
  const chat = m.chat.id;
  let fileId, type, size;
  if (m.photo) {
    const p = m.photo[m.photo.length - 1];
    fileId = p.file_id; type = "image/jpeg"; size = p.file_size;
  } else {
    fileId = m.document.file_id; type = m.document.mime_type; size = m.document.file_size;
    if (!TYPES[type]) return send(chat, "Пришлите, пожалуйста, фото, скриншот или PDF квитанции.");
  }
  if (size > MAX_BYTES) return send(chat, "Файл слишком большой. Пришлите скриншот квитанции.");

  const info = tg("getFile", { file_id: fileId });
  if (!info.ok) return send(chat, "Не получилось скачать файл. Попробуйте ещё раз.");
  const blob = UrlFetchApp.fetch("https://api.telegram.org/file/bot" + prop("BOT_TOKEN") + "/" + info.result.file_path).getBlob();
  const month = thisMonth();
  const url = saveFile(blob.setName(fileName(month, TYPES[type])));

  const mine = kidsByPhone(parent.phone);
  const kid = mine.length === 1 ? mine[0] : null;
  const pid = addPayment({ month: month, file: url, kid: kid, chat: chat, tgFile: (m.photo ? "photo:" : "doc:") + fileId });

  if (mine.length > 1) {
    send(chat, "✅ Квитанция получена! За кого эта оплата?", {
      reply_markup: { inline_keyboard: mine.map(function (k) { return [{ text: k.name, callback_data: "k|" + pid + "|" + k.id }]; }) },
    });
  } else {
    send(chat, "✅ Квитанция получена" + (kid ? " (" + h(kid.name) + ", " + monthName(month) + ")" : "") + "!\nСадик проверит оплату, и я пришлю подтверждение.", { reply_markup: MAIN_KB });
  }
  // если детей несколько — сообщим садику, когда родитель выберет ребёнка
  if (mine.length <= 1) notifyAdmins(pid, parent, kid, month, m.photo ? "photo" : "doc", fileId);
}

function onCallback(q) {
  const parts = String(q.data || "").split("|"), act = parts[0], pid = parts[1];
  const chat = q.message && q.message.chat.id;

  if (act === "k") { // родитель выбрал ребёнка
    const p = paymentById(pid), kid = kidById(parts[2]);
    if (!p || String(p.chat) !== String(q.from.id) || !kid) return tg("answerCallbackQuery", { callback_query_id: q.id, text: "Не получилось" });
    const first = !p.childId;
    review({ id: pid, status: p.status, childId: kid.id });
    tg("answerCallbackQuery", { callback_query_id: q.id, text: "Отмечено" });
    if (first && p.tgFile) notifyAdmins(pid, parentByChat(q.from.id), kid, p.month, p.tgFile.split(":")[0], p.tgFile.slice(p.tgFile.indexOf(":") + 1));
    return tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", text: "✅ Квитанция за <b>" + h(kid.name) + "</b> получена! Садик проверит оплату, и я пришлю подтверждение." });
  }

  if (act === "ok" || act === "no") { // админ подтверждает или отклоняет
    if (!isAdmin(q.from.id)) return tg("answerCallbackQuery", { callback_query_id: q.id, text: "Нет доступа" });
    const p = paymentById(pid);
    if (!p) return tg("answerCallbackQuery", { callback_query_id: q.id, text: "Квитанция не найдена" });
    const kid = kidById(p.childId);
    const amount = p.amount || (kid && kid.fee) || "";
    if (act === "ok" && (!kid || !amount)) return tg("answerCallbackQuery", { callback_query_id: q.id, text: "Выберите ребёнка и сумму в панели", show_alert: true });
    review({ id: pid, status: act === "ok" ? "Подтверждена" : "Отклонена", amount: amount });
    tg("answerCallbackQuery", { callback_query_id: q.id, text: act === "ok" ? "Подтверждено" : "Отклонено" });
    const note = act === "ok" ? "\n\n✅ <b>Подтверждено</b>: " + money(amount) : "\n\n❌ <b>Отклонено</b>";
    return tg("editMessageCaption", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", caption: h(q.message.caption || "") + note });
  }
  tg("answerCallbackQuery", { callback_query_id: q.id });
}

function adminLogin(m, pw) {
  tg("deleteMessage", { chat_id: m.chat.id, message_id: m.message_id }); // прячем пароль из переписки
  if (!pw || pw !== prop("ADMIN_KEY")) {
    Utilities.sleep(800);
    return send(m.chat.id, "Неверный пароль.");
  }
  const props = PropertiesService.getScriptProperties();
  const list = (props.getProperty("ADMIN_CHATS") || "").split(",").filter(Boolean);
  if (list.indexOf(String(m.chat.id)) < 0) list.push(String(m.chat.id));
  props.setProperty("ADMIN_CHATS", list.join(","));
  send(m.chat.id, "Вы администратор ✅\nСюда будут приходить новые квитанции с кнопками «Подтвердить» и «Отклонить».\n\nОтключить: /admin_off");
}

function adminLogout(chat) {
  const list = adminChats().filter(function (a) { return a !== String(chat); });
  PropertiesService.getScriptProperties().setProperty("ADMIN_CHATS", list.join(","));
  send(chat, "Уведомления для администратора отключены.");
}

function notifyAdmins(pid, parent, kid, month, kind, fileId) {
  const admins = adminChats();
  if (!admins.length) return;
  const caption = "🧾 <b>Новая квитанция</b>\n" +
    "От: " + h(parent.name) + ", " + h(fmtPhone(parent.phone)) + "\n" +
    "Ребёнок: " + (kid ? "<b>" + h(kid.name) + "</b>" + (kid.group ? " (" + h(kid.group) + ")" : "") : "не определён" + (parent.childName ? " (со слов: " + h(parent.childName) + ")" : "")) + "\n" +
    "Месяц: " + monthName(month);
  const buttons = [];
  if (kid && kid.fee) buttons.push([{ text: "✅ Подтвердить " + money(kid.fee), callback_data: "ok|" + pid }, { text: "❌ Отклонить", callback_data: "no|" + pid }]);
  else buttons.push([{ text: "❌ Отклонить", callback_data: "no|" + pid }]);
  if (prop("SITE_URL")) buttons.push([{ text: "Открыть панель оплат", url: prop("SITE_URL").replace(/\/?$/, "/") + "admin.html" }]);
  admins.forEach(function (a) {
    const payload = { chat_id: a, caption: caption, parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } };
    if (kind === "photo") { payload.photo = fileId; tg("sendPhoto", payload); }
    else { payload.document = fileId; tg("sendDocument", payload); }
  });
}

function notifyParent(p) {
  const kid = kidById(p.childId);
  const who = (kid ? "<b>" + h(kid.name) + "</b> · " : "") + monthName(p.month);
  if (p.status === "Подтверждена") {
    send(p.chat, "✅ <b>Оплата подтверждена!</b>\n" + who + (p.amount ? " · " + money(p.amount) : "") + "\n\nСпасибо! 💗");
  } else if (p.status === "Отклонена") {
    send(p.chat, "⚠️ Не получилось подтвердить квитанцию (" + who + ").\n\nПожалуйста, отправьте другую квитанцию или напишите нам: wa.me/" + WHATSAPP);
  }
}

function statusText(parent) {
  const mine = kidsByPhone(parent.phone), month = thisMonth();
  if (!mine.length) return "Мы ещё не привязали ваш номер к ребёнку — садик скоро это сделает. Квитанции можно отправлять уже сейчас.";
  const pays = rows(PAYMENTS, P_HEAD).filter(function (r) { return String(r[2]) === month; });
  return "📊 <b>" + capital(monthName(month)) + "</b>\n\n" + mine.map(function (k) {
    const own = pays.filter(function (r) { return r[7] === k.id; });
    const paid = own.filter(function (r) { return r[6] === "Подтверждена"; }).reduce(function (s, r) { return s + (Number(r[4]) || 0); }, 0);
    const wait = own.some(function (r) { return r[6] === "Новая"; });
    let st;
    if (paid && (!k.fee || paid >= k.fee)) st = "✅ оплачено";
    else if (paid) st = "🟡 оплачено " + money(paid) + " из " + money(k.fee);
    else if (wait) st = "⏳ квитанция на проверке";
    else st = "❗ не оплачено" + (k.fee ? " (" + money(k.fee) + ")" : "");
    return "<b>" + h(k.name) + "</b> — " + st;
  }).join("\n");
}

function helpText() {
  return "🧾 <b>Как отправить квитанцию</b>\nОплатите садик и пришлите сюда фото, скриншот или PDF квитанции.\n\n" +
    "🔔 <b>Уведомления</b>\nКогда садик проверит оплату, я напишу. Если забудете оплатить — тоже напомню.\n\n" +
    "📊 <b>Мой статус</b> — оплачен ли текущий месяц.\n\n" +
    "Вопросы: wa.me/" + WHATSAPP;
}

// ---------- напоминания ----------

function remindMany(ids, month) {
  month = /^\d{4}-\d{2}$/.test(month || "") ? month : thisMonth();
  let sent = 0;
  ids.forEach(function (id) { sent += remindChild(kidById(id), month); });
  return { ok: true, sent: sent };
}

function remindChild(kid, month) {
  if (!kid) return 0;
  const paid = rows(PAYMENTS, P_HEAD).filter(function (r) { return String(r[2]) === month && r[7] === kid.id && r[6] === "Подтверждена"; })
    .reduce(function (s, r) { return s + (Number(r[4]) || 0); }, 0);
  const left = kid.fee ? kid.fee - paid : 0;
  const msg = "🔔 Напоминаем об оплате детского сада «Мир детства» за " + monthName(month) +
    " — <b>" + h(kid.name) + "</b>" + (left > 0 ? ", " + money(left) : "") + ".\n\nПосле оплаты просто пришлите сюда квитанцию 🧾";
  let n = 0;
  rows(PARENTS, R_HEAD).forEach(function (r) {
    if (digits(r[2]) && digits(r[2]) === kid.phone) { send(r[0], msg, { reply_markup: MAIN_KB }); n++; }
  });
  return n;
}

// Запускается по расписанию (создаётся в setup): напоминает всем, кто не оплатил текущий месяц
function remindDebtors() {
  const month = thisMonth();
  const pays = rows(PAYMENTS, P_HEAD).filter(function (r) { return String(r[2]) === month && r[6] === "Подтверждена"; });
  let sent = 0, debtors = 0;
  kids().forEach(function (k) {
    const paid = pays.filter(function (r) { return r[7] === k.id; }).reduce(function (s, r) { return s + (Number(r[4]) || 0); }, 0);
    if (paid && (!k.fee || paid >= k.fee)) return;
    debtors++;
    sent += remindChild(k, month);
  });
  adminChats().forEach(function (a) { send(a, "🔔 Автонапоминание за " + monthName(month) + ": не оплатили " + debtors + ", сообщений отправлено " + sent + "."); });
}

// ---------- первичная настройка: запустите один раз из редактора ----------

function setup() {
  const props = PropertiesService.getScriptProperties();
  ["ADMIN_KEY", "BOT_TOKEN"].forEach(function (k) {
    if (!prop(k)) throw new Error("Добавьте свойство скрипта " + k);
  });
  const webUrl = prop("WEB_APP_URL") || ScriptApp.getService().getUrl();
  if (!webUrl || !/\/exec$/.test(webUrl)) throw new Error("Сначала разверните скрипт как веб-приложение и откройте его ссылку");
  let secret = props.getProperty("TG_SECRET");
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, ""); props.setProperty("TG_SECRET", secret); }

  const me = tg("getMe", {});
  if (!me.ok) throw new Error("Токен бота не подходит: " + me.description);
  props.setProperty("BOT_USERNAME", me.result.username);

  const hook = tg("setWebhook", { url: webUrl + "?tg=" + secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  if (!hook.ok) throw new Error("Не удалось подключить бота: " + hook.description);
  tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }, { command: "status", description: "Мой статус оплаты" }, { command: "help", description: "Помощь" }] });

  // автонапоминания 5-го и 10-го числа в 10:00 по Алматы
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "remindDebtors") ScriptApp.deleteTrigger(t); });
  [5, 10].forEach(function (d) { ScriptApp.newTrigger("remindDebtors").timeBased().onMonthDay(d).atHour(10).inTimezone(TZ).create(); });

  folder();
  sheet(PAYMENTS, P_HEAD); sheet(CHILDREN, C_HEAD); sheet(PARENTS, R_HEAD);
  props.setProperty("SETUP_DONE", "1");
  console.log("Готово! Бот: https://t.me/" + me.result.username);
  return me.result.username;
}

// =================== помощники ===================

function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || SETTINGS[k] || null; }

function tg(method, payload) {
  const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop("BOT_TOKEN") + "/" + method, {
    method: "post", contentType: "application/json", payload: JSON.stringify(payload || {}), muteHttpExceptions: true,
  });
  try { return JSON.parse(res.getContentText()); } catch (e) { return { ok: false }; }
}

function send(chat, msg, extra) {
  return tg("sendMessage", Object.assign({ chat_id: chat, text: msg, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));
}

function adminChats() { return (prop("ADMIN_CHATS") || "").split(",").filter(Boolean); }
function isAdmin(id) { return adminChats().indexOf(String(id)) >= 0; }

function addPayment(p) {
  const id = "p" + Utilities.getUuid().replace(/-/g, "").slice(0, 11); // буква в начале — чтобы таблица не превратила id в число
  withLock(function () {
    sheet(PAYMENTS, P_HEAD).appendRow([id, new Date(), "'" + p.month, p.kid ? safe(p.kid.name, 100) : "", "", p.file, "Новая", p.kid ? p.kid.id : "", p.chat ? String(p.chat) : "", p.tgFile || ""]);
  });
  return id;
}

function paymentById(id) {
  const r = rows(PAYMENTS, P_HEAD).filter(function (x) { return String(x[0]) === String(id); })[0];
  return r ? { id: String(r[0]), month: String(r[2]), amount: Number(r[4]) || 0, status: String(r[6]), childId: String(r[7] || ""), chat: String(r[8] || ""), tgFile: String(r[9] || "") } : null;
}

function kids() {
  return rows(CHILDREN, C_HEAD).map(function (r) {
    return { id: String(r[0]), name: String(r[1]), parent: String(r[2]), phone: digits(r[3]), group: String(r[4]), fee: Number(r[5]) || 0 };
  });
}
function kidById(id) { return id ? kids().filter(function (k) { return k.id === id; })[0] || null : null; }
function kidsByPhone(phone) { phone = digits(phone); return phone ? kids().filter(function (k) { return k.phone === phone; }) : []; }

function parentByChat(chat) {
  const r = rows(PARENTS, R_HEAD).filter(function (x) { return String(x[0]) === String(chat); })[0];
  return r ? { chat: String(r[0]), name: String(r[1]), phone: digits(r[2]), childName: String(r[3]) } : null;
}
function setParentChild(chat, name) {
  withLock(function () {
    const sh = sheet(PARENTS, R_HEAD), row = findRow(sh, chat);
    if (row) sh.getRange(row, 4).setValue(safe(name, 100));
  });
}

function saveFile(blob) { return folder().createFile(blob).getUrl(); }
function fileName(month, ext) { return month + " " + Utilities.formatDate(new Date(), TZ, "dd.MM HH-mm-ss") + ext; }

function checkKey(key) {
  const real = prop("ADMIN_KEY");
  if (!real) throw new Error("Пароль не настроен: добавьте ADMIN_KEY в свойства скрипта");
  if (key !== real) {
    Utilities.sleep(800); // замедляем подбор пароля
    throw new Error("Неверный пароль");
  }
}

function sheet(name, head) {
  const ss = prop("SHEET_ID") ? SpreadsheetApp.openById(prop("SHEET_ID")) : SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.hideColumns(1);
  } else if (sh.getLastColumn() < head.length) {
    sh.getRange(1, 1, 1, head.length).setValues([head]); // добавились новые колонки
  }
  sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  return sh;
}

function rows(name, head) {
  const sh = sheet(name, head), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, head.length).getValues().filter(function (r) { return r[0] !== ""; });
}

function findRow(sh, id) {
  if (id === undefined || id === null || id === "" || sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function folder() {
  const id = prop("FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(FOLDER_NAME);
  PropertiesService.getScriptProperties().setProperty("FOLDER_ID", f.getId());
  return f;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { fn(); } finally { lock.releaseLock(); }
}

function thisMonth() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM"); }
function monthName(key) { const p = String(key).split("-"); return MONTHS[Number(p[1]) - 1] + " " + p[0]; }
function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function money(n) { return (Number(n) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " ₸"; }
function fmtPhone(p) { const d = digits(p); return d.length === 10 ? "8 " + d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6, 8) + " " + d.slice(8) : String(p || ""); }
function digits(s) { return String(s || "").replace(/\D/g, "").slice(-10); }
function text(s, max) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
function h(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Не даём строке из формы стать формулой в таблице
function safe(s, max) { const t = text(s, max); return /^[=+\-@]/.test(t) ? "'" + t : t; }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
