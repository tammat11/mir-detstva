// Сервер оплат и бота:
// — функции Vercel в папке api/ (по умолчанию),
// — или Google Apps Script: вставьте ссылку веб-приложения (…/exec) в GAS_URL.
// Если сайт открыт как файл с компьютера — демо-режим: данные хранятся только в этом браузере.
const GAS_URL = "";
window.CONFIG = {
  API_URL: location.protocol === "file:" ? "" : (GAS_URL || "/api/app"),
  WHATSAPP: "77772829292",
};
