// API для pay.html и admin.html
import { api, receiptFile } from "../lib/core.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch (e) { body = {}; }
  body = body || {};
  try {
    if (body.action === "file") {
      const f = await receiptFile(body.key, body.id);
      if (!f) return res.status(404).json({ ok: false, error: "Файл не найден" });
      res.setHeader("Content-Type", f.contentType || "application/octet-stream");
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(200).send(f.bytes);
    }
    res.status(200).json(await api(body));
  } catch (err) {
    res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}
