// Webhook Telegram-бота
import { waitUntil } from "@vercel/functions";
import { onUpdate, tgSecret } from "../lib/core.js";

export default async function handler(req, res) {
  if (req.method !== "POST" || req.headers["x-telegram-bot-api-secret-token"] !== tgSecret()) return res.status(401).end();
  let u = null;
  try { u = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch (e) { /* пустое тело */ }
  // Отвечаем Telegram сразу, а сообщение обрабатываем после ответа —
  // иначе при долгом чтении квитанции Telegram пришлёт то же сообщение повторно
  if (u) waitUntil(onUpdate(u).catch(err => console.error(err)));
  res.status(200).end("ok");
}
