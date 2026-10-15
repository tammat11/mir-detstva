// Webhook Telegram-бота
import { onUpdate, tgSecret } from "../lib/core.js";

export default async function handler(req, res) {
  if (req.method !== "POST" || req.headers["x-telegram-bot-api-secret-token"] !== tgSecret()) return res.status(401).end();
  try {
    const u = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (u) await onUpdate(u);
  } catch (err) {
    console.error(err);
  }
  res.status(200).end("ok"); // всегда 200, чтобы Telegram не присылал то же сообщение повторно
}
