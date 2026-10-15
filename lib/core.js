// Логика оплат и Telegram-бота «Мир детства» (Vercel Functions).
import crypto from "node:crypto";
import { read, update, saveFile, readFile } from "./db.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TZ = "Asia/Almaty";
const WHATSAPP = "77772829292";
const STATUSES = ["Новая", "Подтверждена", "Отклонена"];
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

const CHILDREN = "db/children.json";
const PARENTS = "db/parents.json";
const META = "db/meta.json";
const bucket = m => `db/payments-${m}.json`;
const EMPTY = { items: [] };

// ---------- помощники ----------

export function thisMonth(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
}
export function shiftMonth(key, n) {
  const [y, m] = key.split("-").map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
const isMonth = s => /^\d{4}-\d{2}$/.test(s || "");
const monthName = k => { const [y, m] = k.split("-"); return MONTHS[Number(m) - 1] + " " + y; };
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
const money = n => (Number(n) || 0).toLocaleString("ru-RU") + " ₸";
export const digits = s => String(s || "").replace(/\D/g, "").slice(-10);
const fmtPhone = p => { const d = digits(p); return d.length === 10 ? `8 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}` : String(p || ""); };
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const h = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uid = () => crypto.randomBytes(6).toString("hex");
// id квитанции содержит месяц загрузки — по нему находим файл с оплатами
const newPid = m => "p" + m.replace("-", "") + uid();
const pidMonth = pid => { const x = /^p(\d{4})(\d{2})/.exec(pid || ""); return x ? `${x[1]}-${x[2]}` : null; };

export function checkKey(key) {
  const real = process.env.ADMIN_KEY;
  if (!real) throw new Error("Пароль не настроен: добавьте ADMIN_KEY в настройках Vercel");
  const a = crypto.createHash("sha256").update(String(key || "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new Error("Неверный пароль");
}
export const tgSecret = () => crypto.createHash("sha256").update("tg:" + (process.env.BOT_TOKEN || "")).digest("hex").slice(0, 48);

const kids = async () => (await read(CHILDREN, EMPTY)).items;
const parents = async () => (await read(PARENTS, EMPTY)).items;
const meta = async () => read(META, { admins: [], bot: "" });
const kidsByPhone = (all, phone) => { phone = digits(phone); return phone ? all.filter(k => k.phone === phone) : []; };

// оплаты за месяц лежат в файлах соседних месяцев (месяц можно поправить на ±1)
async function paymentsFor(month) {
  const lists = await Promise.all([-1, 0, 1].map(n => read(bucket(shiftMonth(month, n)), EMPTY)));
  return lists.flatMap(l => l.items).filter(p => p.month === month);
}
async function paymentById(pid) {
  const m = pidMonth(pid);
  return m ? (await read(bucket(m), EMPTY)).items.find(p => p.id === pid) || null : null;
}

// Чтение квитанции в отдельном процессе с ограничением по времени — сбой распознавания не роняет бота
const OCR_CHILD = fileURLToPath(new URL("./ocr-child.js", import.meta.url));
function readReceiptSafe(bytes, type, timeoutMs = 40000) {
  return new Promise(resolve => {
    let done = false, child;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill(); } catch (e) {} resolve(r || null); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = fork(OCR_CHILD, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      child.on("message", msg => finish(msg && msg.r));
      child.on("exit", () => finish(null));
      child.on("error", e => { console.error("OCR child:", e); finish(null); });
      child.send({ b64: Buffer.from(bytes).toString("base64"), type });
    } catch (e) { console.error("OCR fork:", e); finish(null); }
  });
}

// Та же квитанция (по номеру) за последние месяцы — защита от повторной отправки
async function findDuplicate(receiptNo, selfId) {
  if (!receiptNo) return null;
  const m = thisMonth();
  const lists = await Promise.all([0, -1, -2, -3].map(n => read(bucket(shiftMonth(m, n)), EMPTY)));
  return lists.flatMap(l => l.items).find(p => p.id !== selfId && p.ocr && p.ocr.receiptNo === receiptNo && p.status !== "Отклонена") || null;
}

// Дописать к уже сохранённой квитанции то, что удалось прочитать
async function attachOcr(pay, ocr) {
  if (!ocr) return pay;
  const dup = await findDuplicate(ocr.receiptNo, pay.id);
  const row = await update(bucket(pidMonth(pay.id)), EMPTY, d => {
    const p = d.items.find(x => x.id === pay.id);
    if (!p) return null;
    p.ocr = ocr;
    if (!p.amount && ocr.amount) p.amount = Math.round(ocr.amount);
    p.duplicateOf = dup ? dup.id : "";
    return { ...p };
  });
  return { ...(row || pay), dup };
}

// Получатель из квитанции не совпадает с RECEIVER_NAME (если задан) — подсказка садику
function receiverMismatch(ocr) {
  const want = String(process.env.RECEIVER_NAME || "").toLowerCase().replace(/[^a-zа-яё ]/g, " ").split(/\s+/).filter(w => w.length > 1);
  if (!want.length || !ocr || !ocr.recipient) return false;
  const got = ocr.recipient.toLowerCase();
  return !want.some(w => got.includes(w));
}

const ocrLine = o => o ? [o.bank, o.amount ? money(o.amount) : "", o.date ? o.date.split(" ")[0].split("-").reverse().join(".") + (o.date.split(" ")[1] ? " " + o.date.split(" ")[1] : "") : "", o.sender ? "от " + o.sender : "", o.recipient ? "→ " + o.recipient : ""].filter(Boolean).join(" · ") : "";

async function addPayment(p) {
  const id = newPid(p.uploadMonth);
  const row = { id, date: new Date().toISOString(), month: p.month, childId: p.childId || "", amount: 0, status: "Новая", file: p.file, type: p.type, chat: p.chat ? String(p.chat) : "", tgFile: p.tgFile || "", ocr: null, duplicateOf: "" };
  await update(bucket(p.uploadMonth), EMPTY, d => { d.items.push(row); });
  return row;
}

// =================== API сайта ===================

export async function api(req) {
  const a = req.action;
  if (a === "upload") return upload(req);
  if (a === "info") return { ok: true, bot: (await meta()).bot || "" };
  checkKey(req.key);
  if (a === "data") return data(isMonth(req.month) ? req.month : thisMonth());
  if (a === "review") return review(req);
  if (a === "saveChild") return saveChild(req.child || {});
  if (a === "deleteChild") { await update(CHILDREN, EMPTY, d => { d.items = d.items.filter(k => k.id !== req.id); }); return { ok: true }; }
  if (a === "remind") return remindMany(req.childIds || [], req.month);
  throw new Error("Неизвестное действие");
}

async function upload(r) {
  if (!r.file || !r.file.data) throw new Error("Приложите квитанцию");
  const ext = TYPES[r.file.type];
  if (!ext) throw new Error("Загрузите фото (JPG, PNG) или PDF");
  const bytes = Buffer.from(r.file.data, "base64");
  if (bytes.length > MAX_BYTES) throw new Error("Файл больше 8 МБ");
  const m = thisMonth();
  const path = `receipts/${m}/${uid()}${ext}`;
  await saveFile(path, bytes, r.file.type);
  let pay = await addPayment({ uploadMonth: m, month: isMonth(r.month) ? r.month : m, file: path, type: r.file.type });
  pay = await attachOcr(pay, await readReceiptSafe(bytes, r.file.type));
  return { ok: true, amount: pay.amount || 0, duplicate: !!pay.duplicateOf };
}

async function data(month) {
  const [payments, children, ps, mt] = await Promise.all([paymentsFor(month), kids(), parents(), meta()]);
  return {
    ok: true, month, bot: mt.bot || "",
    payments: payments.map(p => ({ id: p.id, date: p.date, month: p.month, amount: p.amount, status: p.status, childId: p.childId, chat: p.chat, file: "blob:" + p.id, type: p.type, ocr: p.ocr || null, ocrText: ocrLine(p.ocr), duplicate: !!p.duplicateOf, wrongReceiver: receiverMismatch(p.ocr) })),
    children,
    parents: ps.map(p => ({ chat: p.chat, name: p.name, phone: p.phone, childName: p.childName || "", username: p.username || "", date: p.date })),
  };
}

// Файл квитанции для панели — только с паролем
export async function receiptFile(key, pid) {
  checkKey(key);
  const p = await paymentById(pid);
  if (!p) return null;
  return readFile(p.file);
}

export async function review(r) {
  if (!STATUSES.includes(r.status)) throw new Error("Неверный статус");
  const up = pidMonth(r.id);
  if (!up) throw new Error("Квитанция не найдена");
  if (r.month && (!isMonth(r.month) || Math.abs(monthDiff(up, r.month)) > 1)) throw new Error("Неверный месяц");
  const res = await update(bucket(up), EMPTY, d => {
    const p = d.items.find(x => x.id === r.id);
    if (!p) throw new Error("Квитанция не найдена");
    const before = p.status;
    if (r.childId !== undefined) p.childId = String(r.childId || "");
    if (r.amount !== undefined) p.amount = Math.max(0, Math.round(Number(r.amount) || 0));
    if (r.month) p.month = r.month;
    p.status = r.status;
    return { before, after: { ...p } };
  });
  if (res.after.chat && res.before !== res.after.status && res.after.status !== "Новая") await notifyParent(res.after);
  return { ok: true };
}
const monthDiff = (a, b) => { const [y1, m1] = a.split("-").map(Number), [y2, m2] = b.split("-").map(Number); return (y2 - y1) * 12 + (m2 - m1); };

async function saveChild(c) {
  if (!clean(c.name, 100)) throw new Error("Укажите имя ребёнка");
  const row = { name: clean(c.name, 100), parent: clean(c.parent, 100), phone: digits(c.phone), group: clean(c.group, 50), fee: Math.max(0, Math.round(Number(c.fee) || 0)) };
  await update(CHILDREN, EMPTY, d => {
    const k = c.id && d.items.find(x => x.id === c.id);
    if (k) Object.assign(k, row); else d.items.push({ id: "k" + uid(), ...row });
  });
  return { ok: true };
}

// =================== Telegram ===================

export async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}),
  });
  return r.json().catch(() => ({ ok: false }));
}
const send = (chat, text, extra) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) });

const MAIN_KB = { keyboard: [[{ text: "📊 Мой статус" }, { text: "❓ Помощь" }]], resize_keyboard: true };
const PHONE_KB = { keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

export async function onUpdate(u) {
  if (u.message) return onMessage(u.message);
  if (u.callback_query) return onCallback(u.callback_query);
}

async function onMessage(m) {
  if (!m.chat || m.chat.type !== "private") return;
  const chat = String(m.chat.id), text = String(m.text || "").trim();

  if (text === "/admin_off") return adminLogout(chat);
  if (/^\/admin\b/.test(text)) return adminLogin(m, text.split(/\s+/)[1] || "");

  if (m.contact) {
    if (m.contact.user_id !== m.from.id) return send(chat, "Пожалуйста, отправьте <b>свой</b> номер кнопкой ниже 👇", { reply_markup: PHONE_KB });
    return register(m, m.contact.phone_number);
  }

  const parent = (await parents()).find(p => p.chat === chat);
  if (!parent) {
    return send(chat,
      "Здравствуйте! 👋 Это бот детского сада <b>«Мир детства»</b>.\n\n" +
      "Здесь можно отправлять квитанции об оплате и получать уведомления, когда оплату подтвердят.\n\n" +
      "Чтобы начать, поделитесь номером телефона — по нему мы найдём вашего ребёнка.",
      { reply_markup: PHONE_KB });
  }

  if (parent.state === "child" && text && text[0] !== "/" && !m.photo && !m.document) {
    await update(PARENTS, EMPTY, d => { const p = d.items.find(x => x.chat === chat); if (p) { p.childName = clean(text, 100); delete p.state; } });
    return send(chat, "Спасибо! Записали: <b>" + h(text) + "</b>.\n\nТеперь просто отправляйте сюда фото или скриншот квитанции 🧾", { reply_markup: MAIN_KB });
  }

  if (m.photo || m.document) return onReceipt(m, parent);
  if (text === "/start") return send(chat, "С возвращением, " + h(parent.name) + "! Отправьте фото или скриншот квитанции — я передам её в садик 🧾", { reply_markup: MAIN_KB });
  if (text === "📊 Мой статус" || text === "/status") return send(chat, await statusText(parent), { reply_markup: MAIN_KB });
  if (text === "❓ Помощь" || text === "/help") return send(chat, helpText(), { reply_markup: MAIN_KB });
  return send(chat, "Отправьте фото, скриншот или PDF квитанции — я передам её в садик 🧾", { reply_markup: MAIN_KB });
}

async function register(m, phoneRaw) {
  const chat = String(m.chat.id), phone = digits(phoneRaw);
  const name = clean([m.from.first_name, m.from.last_name].filter(Boolean).join(" "), 100);
  const mine = kidsByPhone(await kids(), phone);
  await update(PARENTS, EMPTY, d => {
    let p = d.items.find(x => x.chat === chat);
    if (!p) { p = { chat }; d.items.push(p); }
    Object.assign(p, { name, phone, username: clean(m.from.username, 64), date: new Date().toISOString() });
    if (mine.length) delete p.state; else p.state = "child";
  });
  if (mine.length) {
    return send(chat,
      "Готово, " + h(name) + "! ✅\n\nНашли: " + mine.map(k => "<b>" + h(k.name) + "</b>" + (k.group ? " (" + h(k.group) + ")" : "")).join(", ") + ".\n\n" +
      "Теперь просто отправляйте сюда фото или скриншот квитанции 🧾\nКогда садик подтвердит оплату, я пришлю уведомление.",
      { reply_markup: MAIN_KB });
  }
  return send(chat, "Номер сохранён ✅\n\nНапишите, пожалуйста, <b>имя и фамилию ребёнка</b> — чтобы садик понял, чьи квитанции.", { reply_markup: { remove_keyboard: true } });
}

async function onReceipt(m, parent) {
  const chat = String(m.chat.id);
  let fileId, type, size;
  if (m.photo) {
    const p = m.photo[m.photo.length - 1];
    fileId = p.file_id; type = "image/jpeg"; size = p.file_size;
  } else {
    fileId = m.document.file_id; type = m.document.mime_type; size = m.document.file_size;
    if (!TYPES[type]) return send(chat, "Пришлите, пожалуйста, фото, скриншот или PDF квитанции.");
  }
  if (size > MAX_BYTES) return send(chat, "Файл слишком большой. Пришлите скриншот квитанции.");

  // сразу показываем, что квитанция дошла — чтение может занять несколько секунд
  const ack = await send(chat, "⏳ Получил квитанцию, проверяю…");
  const ackId = ack && ack.ok && ack.result ? ack.result.message_id : null;
  try { return await processReceipt(m, parent, fileId, type); }
  catch (e) { console.error(e); return send(chat, "Не получилось обработать квитанцию. Попробуйте ещё раз через минуту.", { reply_markup: MAIN_KB }); }
  finally { if (ackId) await tg("deleteMessage", { chat_id: chat, message_id: ackId }); }
}

async function processReceipt(m, parent, fileId, type) {
  const chat = String(m.chat.id);
  const info = await tg("getFile", { file_id: fileId });
  if (!info.ok) return send(chat, "Не получилось скачать файл. Попробуйте ещё раз.");
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${info.result.file_path}`);
  if (!res.ok) return send(chat, "Не получилось скачать файл. Попробуйте ещё раз.");
  const month = thisMonth();
  const path = `receipts/${month}/${uid()}${TYPES[type]}`;
  const bytes = Buffer.from(await res.arrayBuffer());
  await saveFile(path, bytes, type);

  // сначала сохраняем квитанцию — она не потеряется, даже если чтение не удастся
  const mine = kidsByPhone(await kids(), parent.phone);
  const kid = mine.length === 1 ? mine[0] : null;
  const kind = m.photo ? "photo" : "doc";
  let pay = await addPayment({ uploadMonth: month, month, file: path, type, childId: kid ? kid.id : "", chat, tgFile: kind + ":" + fileId });
  const ocr = await readReceiptSafe(bytes, type);
  pay = await attachOcr(pay, ocr);

  if (pay.duplicateOf) {
    const was = pay.dup, when = was && new Date(was.date).toLocaleString("ru-RU", { timeZone: TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const st = !was ? "" : was.status === "Подтверждена" ? " — оплата по ней уже подтверждена ✅" : " — она уже на проверке ⏳";
    await send(chat, "⚠️ Такая квитанция уже есть" + (when ? ": её отправляли " + when : "") + st + ".\n" + (ocr.receiptNo ? "№ " + h(ocr.receiptNo) + "\n" : "") + "\nЕсли это другая оплата — пришлите, пожалуйста, её квитанцию.", { reply_markup: MAIN_KB });
    await notifyAdmins(pay, parent, kid);
    return;
  }
  if (ocr && ocr.success === false) {
    await send(chat, "⚠️ Похоже, в квитанции перевод не прошёл. Проверьте, пожалуйста, оплату. Садик всё равно посмотрит квитанцию.", { reply_markup: MAIN_KB });
  }

  if (mine.length > 1) {
    await send(chat, "✅ Квитанция получена! За кого эта оплата?", {
      reply_markup: { inline_keyboard: mine.map(k => [{ text: k.name, callback_data: "k|" + pay.id + "|" + k.id }]) },
    });
    return; // садику сообщим, когда родитель выберет ребёнка
  }
  const what = [kid ? h(kid.name) : "", pay.amount ? money(pay.amount) : "", monthName(month)].filter(Boolean).join(", ");
  await send(chat, "✅ Квитанция получена (" + what + ")!\nСадик проверит оплату, и я пришлю подтверждение.", { reply_markup: MAIN_KB });
  await notifyAdmins(pay, parent, kid);
}

async function onCallback(q) {
  const [act, pid, extra] = String(q.data || "").split("|");
  const chat = q.message && q.message.chat.id;
  const answer = (text, alert) => tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: !!alert });

  if (act === "k") { // родитель выбрал ребёнка
    const [p, all] = await Promise.all([paymentById(pid), kids()]);
    const kid = all.find(k => k.id === extra);
    if (!p || p.chat !== String(q.from.id) || !kid) return answer("Не получилось");
    const first = !p.childId;
    await review({ id: pid, status: p.status, childId: kid.id });
    await answer("Отмечено");
    if (first) await notifyAdmins({ ...p, childId: kid.id }, (await parents()).find(x => x.chat === p.chat), kid);
    return tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", text: "✅ Квитанция за <b>" + h(kid.name) + "</b> получена! Садик проверит оплату, и я пришлю подтверждение." });
  }

  if (act === "ok" || act === "no") { // админ подтверждает или отклоняет
    if (!(await meta()).admins.includes(String(q.from.id))) return answer("Нет доступа");
    const p = await paymentById(pid);
    if (!p) return answer("Квитанция не найдена");
    const kid = (await kids()).find(k => k.id === p.childId);
    const amount = p.amount || (kid && kid.fee) || 0;
    if (act === "ok" && (!kid || !amount)) return answer("Выберите ребёнка и сумму в панели оплат", true);
    await review({ id: pid, status: act === "ok" ? "Подтверждена" : "Отклонена", amount });
    await answer(act === "ok" ? "Подтверждено" : "Отклонено");
    const note = act === "ok" ? "\n\n✅ <b>Подтверждено</b>: " + money(amount) : "\n\n❌ <b>Отклонено</b>";
    return tg("editMessageCaption", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", caption: h(q.message.caption || "") + note });
  }
  return answer();
}

async function adminLogin(m, pw) {
  await tg("deleteMessage", { chat_id: m.chat.id, message_id: m.message_id }); // прячем пароль из переписки
  try { checkKey(pw); } catch (e) {
    await new Promise(r => setTimeout(r, 800));
    return send(m.chat.id, "Неверный пароль.");
  }
  await update(META, { admins: [], bot: "" }, d => { if (!d.admins.includes(String(m.chat.id))) d.admins.push(String(m.chat.id)); });
  return send(m.chat.id, "Вы администратор ✅\nСюда будут приходить новые квитанции с кнопками «Подтвердить» и «Отклонить».\n\nОтключить: /admin_off");
}

async function adminLogout(chat) {
  await update(META, { admins: [], bot: "" }, d => { d.admins = d.admins.filter(a => a !== chat); });
  return send(chat, "Уведомления для администратора отключены.");
}

async function notifyAdmins(pay, parent, kid) {
  const { admins } = await meta();
  if (!admins.length || !pay.tgFile) return;
  parent = parent || { name: "", phone: "" };
  const caption = "🧾 <b>Новая квитанция</b>\n" +
    "От: " + h(parent.name) + ", " + h(fmtPhone(parent.phone)) + "\n" +
    "Ребёнок: " + (kid ? "<b>" + h(kid.name) + "</b>" + (kid.group ? " (" + h(kid.group) + ")" : "") : "не определён" + (parent.childName ? " (со слов: " + h(parent.childName) + ")" : "")) + "\n" +
    "Месяц: " + monthName(pay.month) +
    (pay.ocr ? "\n\n🔎 Распознано: " + h(ocrLine(pay.ocr)) + (pay.ocr.receiptNo ? "\n№ " + h(pay.ocr.receiptNo) : "") : "\n\n🔎 Квитанцию не удалось прочитать — проверьте сумму вручную") +
    (pay.amount && kid && kid.fee && pay.amount < kid.fee ? "\n🟡 Меньше суммы за месяц (" + money(kid.fee) + ")" : "") +
    (pay.duplicateOf ? "\n⚠️ <b>Эта квитанция уже была отправлена раньше!</b>" : "") +
    (receiverMismatch(pay.ocr) ? "\n⚠️ <b>Получатель не совпадает</b>" : "") +
    (pay.ocr && pay.ocr.success === false ? "\n⚠️ <b>Перевод, похоже, не прошёл</b>" : "");
  const sum = pay.amount || (kid && kid.fee) || 0;
  const buttons = [];
  if (kid && sum) buttons.push([{ text: "✅ Подтвердить " + money(sum), callback_data: "ok|" + pay.id }, { text: "❌ Отклонить", callback_data: "no|" + pay.id }]);
  else buttons.push([{ text: "❌ Отклонить", callback_data: "no|" + pay.id }]);
  if (process.env.SITE_URL) buttons.push([{ text: "Открыть панель оплат", url: process.env.SITE_URL.replace(/\/?$/, "/") + "admin.html" }]);
  const [kind, fileId] = [pay.tgFile.split(":")[0], pay.tgFile.slice(pay.tgFile.indexOf(":") + 1)];
  await Promise.all(admins.map(a => {
    const payload = { chat_id: a, caption, parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } };
    return kind === "photo" ? tg("sendPhoto", { ...payload, photo: fileId }) : tg("sendDocument", { ...payload, document: fileId });
  }));
}

async function notifyParent(p) {
  const kid = (await kids()).find(k => k.id === p.childId);
  const who = (kid ? "<b>" + h(kid.name) + "</b> · " : "") + monthName(p.month);
  if (p.status === "Подтверждена") return send(p.chat, "✅ <b>Оплата подтверждена!</b>\n" + who + (p.amount ? " · " + money(p.amount) : "") + "\n\nСпасибо! 💗");
  if (p.status === "Отклонена") return send(p.chat, "⚠️ Не получилось подтвердить квитанцию (" + who + ").\n\nПожалуйста, отправьте другую квитанцию или напишите нам: wa.me/" + WHATSAPP);
}

const paidSum = (pays, kidId) => pays.filter(p => p.childId === kidId && p.status === "Подтверждена").reduce((s, p) => s + (Number(p.amount) || 0), 0);

async function statusText(parent) {
  const month = thisMonth(), mine = kidsByPhone(await kids(), parent.phone);
  if (!mine.length) return "Мы ещё не привязали ваш номер к ребёнку — садик скоро это сделает. Квитанции можно отправлять уже сейчас.";
  const pays = await paymentsFor(month);
  return "📊 <b>" + capital(monthName(month)) + "</b>\n\n" + mine.map(k => {
    const paid = paidSum(pays, k.id), wait = pays.some(p => p.childId === k.id && p.status === "Новая");
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
    "📊 <b>Мой статус</b> — оплачен ли текущий месяц.\n\nВопросы: wa.me/" + WHATSAPP;
}

// ---------- напоминания ----------

async function remindMany(ids, month) {
  month = isMonth(month) ? month : thisMonth();
  const [all, ps, pays] = await Promise.all([kids(), parents(), paymentsFor(month)]);
  let sent = 0;
  for (const id of ids) { const k = all.find(x => x.id === id); if (k) sent += await remindChild(k, month, ps, pays); }
  return { ok: true, sent };
}

async function remindChild(kid, month, ps, pays) {
  const left = kid.fee ? kid.fee - paidSum(pays, kid.id) : 0;
  const msg = "🔔 Напоминаем об оплате детского сада «Мир детства» за " + monthName(month) +
    " — <b>" + h(kid.name) + "</b>" + (left > 0 ? ", " + money(left) : "") + ".\n\nПосле оплаты просто пришлите сюда квитанцию 🧾";
  const to = ps.filter(p => p.phone && p.phone === kid.phone);
  for (const p of to) await send(p.chat, msg, { reply_markup: MAIN_KB });
  return to.length;
}

// Вызывается по расписанию (vercel.json → crons)
export async function remindDebtors() {
  const month = thisMonth(), today = new Date().toISOString().slice(0, 10);
  // не больше одного раза в день, даже если адрес вызовут повторно
  const fresh = await update(META, { admins: [], bot: "" }, d => { if (d.lastCron === today) return false; d.lastCron = today; return true; });
  if (!fresh) return { skipped: true };
  const [all, ps, pays, mt] = await Promise.all([kids(), parents(), paymentsFor(month), meta()]);
  let sent = 0, debtors = 0;
  for (const k of all) {
    const paid = paidSum(pays, k.id);
    if (paid && (!k.fee || paid >= k.fee)) continue;
    debtors++;
    sent += await remindChild(k, month, ps, pays);
  }
  for (const a of mt.admins) await send(a, "🔔 Автонапоминание за " + monthName(month) + ": не оплатили " + debtors + ", сообщений отправлено " + sent + ".");
  return { debtors, sent };
}

// ---------- запуск бота ----------

export async function setup(host) {
  if (!process.env.BOT_TOKEN) throw new Error("Добавьте BOT_TOKEN в настройках Vercel (Settings → Environment Variables) и сделайте Redeploy");
  const me = await tg("getMe", {});
  if (!me.ok) throw new Error("Токен бота не подходит: " + (me.description || ""));
  const hook = await tg("setWebhook", { url: `https://${host}/api/tg`, secret_token: tgSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  if (!hook.ok) throw new Error("Не удалось подключить бота: " + (hook.description || ""));
  await tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }, { command: "status", description: "Мой статус оплаты" }, { command: "help", description: "Помощь" }] });
  await update(META, { admins: [], bot: "" }, d => { d.bot = me.result.username; });
  return me.result.username;
}
