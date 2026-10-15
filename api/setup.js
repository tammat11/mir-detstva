// Запуск бота: откройте /api/setup, введите пароль садика (ADMIN_KEY) — один раз после настройки переменных
import { setup, checkKey } from "../lib/core.js";

const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Запуск бота</title><div style="font:18px -apple-system,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:28px;color:#1f2b4d">${msg}</div>`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const key = (req.body && req.body.key) || "";
  if (req.method !== "POST" || !key) {
    return res.status(200).send(page(`<h2>Запуск бота «Мир детства»</h2><form method="post"><p>Введите пароль садика (ADMIN_KEY):</p><input name="key" type="password" style="font:inherit;width:100%;padding:12px;border:1.5px solid #ccd;border-radius:12px;box-sizing:border-box"><button style="margin-top:14px;font:inherit;font-weight:700;width:100%;padding:14px;border:0;border-radius:12px;background:#e23a7a;color:#fff">Запустить</button></form>`));
  }
  try {
    checkKey(key);
    const bot = await setup(req.headers["x-forwarded-host"] || req.headers.host);
    res.status(200).send(page(`✅ Бот <b>@${esc(bot)}</b> запущен!<br><br>Откройте его в Telegram: <a href="https://t.me/${esc(bot)}">t.me/${esc(bot)}</a><br><br>Чтобы получать квитанции, отправьте боту:<br><code>/admin ваш_пароль</code>`));
  } catch (err) {
    res.status(200).send(page("⚠️ " + esc(err.message)));
  }
}
