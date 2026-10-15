/**
 * Сервер для страниц оплаты «Мир детства».
 * Вставляется в Google Таблицу: Расширения → Apps Script. Инструкция — НАСТРОЙКА-ОПЛАТ.md.
 *
 * Квитанции сохраняются в папку Google Диска владельца таблицы,
 * строки — на листы «Оплаты» и «Дети».
 */

const PAYMENTS = "Оплаты";
const CHILDREN = "Дети";
const FOLDER_NAME = "Квитанции — Мир детства";
const P_HEAD = ["id", "Дата", "Месяц", "Ребёнок", "Сумма", "Файл", "Статус", "id ребёнка"];
const C_HEAD = ["id", "Ребёнок", "Родитель", "Телефон", "Группа", "Сумма в месяц"];
const STATUSES = ["Новая", "Подтверждена", "Отклонена"];
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };

function doGet() {
  return json({ ok: true, service: "mir-detstva-payments" });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.action === "upload") return json(upload(req));
    checkKey(req.key);
    switch (req.action) {
      case "data": return json(data());
      case "review": return json(review(req));
      case "saveChild": return json(saveChild(req.child || {}));
      case "deleteChild": return json(deleteRow(CHILDREN, req.id));
    }
    throw new Error("Неизвестное действие");
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------- действия ----------

function upload(r) {
  if (!r.file || !r.file.data) throw new Error("Приложите квитанцию");
  const month = /^\d{4}-\d{2}$/.test(r.month) ? r.month : Utilities.formatDate(new Date(), "Asia/Almaty", "yyyy-MM");
  const ext = TYPES[r.file.type];
  if (!ext) throw new Error("Загрузите фото (JPG, PNG) или PDF");
  const bytes = Utilities.base64Decode(r.file.data);
  if (bytes.length > MAX_BYTES) throw new Error("Файл больше 8 МБ");

  const name = month + " " + Utilities.formatDate(new Date(), "Asia/Almaty", "dd.MM HH-mm-ss") + ext;
  const file = folder().createFile(Utilities.newBlob(bytes, r.file.type, name));

  withLock(function () {
    sheet(PAYMENTS, P_HEAD).appendRow([Utilities.getUuid(), new Date(), "'" + month, "", "", file.getUrl(), "Новая", ""]);
  });
  return { ok: true };
}

function data() {
  const payments = rows(PAYMENTS, P_HEAD).map(function (r) {
    return {
      id: r[0], date: r[1] instanceof Date ? r[1].toISOString() : String(r[1]), month: String(r[2]),
      amount: Number(r[4]) || 0, file: String(r[5]), status: String(r[6] || "Новая"), childId: String(r[7] || ""),
    };
  });
  const children = rows(CHILDREN, C_HEAD).map(function (r) {
    return { id: r[0], name: String(r[1]), parent: String(r[2]), phone: String(r[3]), group: String(r[4]), fee: Number(r[5]) || 0 };
  });
  return { ok: true, payments: payments, children: children };
}

// Садик отмечает, чей платёж, сумму и статус
function review(r) {
  if (STATUSES.indexOf(r.status) < 0) throw new Error("Неверный статус");
  if (r.month && !/^\d{4}-\d{2}$/.test(r.month)) throw new Error("Неверный месяц");
  withLock(function () {
    const sh = sheet(PAYMENTS, P_HEAD), row = findRow(sh, r.id);
    if (!row) throw new Error("Квитанция не найдена");
    const cur = sh.getRange(row, 1, 1, P_HEAD.length).getValues()[0];
    let childName = cur[3], childId = cur[7];
    if (r.childId !== undefined) {
      childId = String(r.childId || "");
      const kid = rows(CHILDREN, C_HEAD).filter(function (k) { return k[0] === childId; })[0];
      childName = kid ? safe(kid[1], 100) : "";
    }
    const month = r.month ? "'" + r.month : "'" + cur[2];
    const amount = r.amount !== undefined ? Math.max(0, Math.round(Number(r.amount) || 0)) || "" : cur[4];
    sh.getRange(row, 3, 1, 6).setValues([[month, childName, amount, cur[5], r.status, childId]]);
  });
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

// ---------- помощники ----------

function checkKey(key) {
  const real = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  if (!real) throw new Error("Пароль не настроен: добавьте ADMIN_KEY в свойства скрипта");
  if (key !== real) {
    Utilities.sleep(800); // замедляем подбор пароля
    throw new Error("Неверный пароль");
  }
}

function sheet(name, head) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
    sh.hideColumns(1);
  }
  return sh;
}

function rows(name, head) {
  const sh = sheet(name, head), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, head.length).getValues().filter(function (r) { return r[0]; });
}

function findRow(sh, id) {
  if (!id || sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function folder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty("FOLDER_ID", f.getId());
  return f;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { fn(); } finally { lock.releaseLock(); }
}

function digits(s) { return String(s || "").replace(/\D/g, "").slice(-10); }
function text(s, max) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
// Не даём строке из формы стать формулой в таблице
function safe(s, max) { const t = text(s, max); return /^[=+\-@]/.test(t) ? "'" + t : t; }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
