// Автонапоминания должникам (расписание в vercel.json)
import { remindDebtors } from "../lib/core.js";

export default async function handler(req, res) {
  // Vercel присылает этот заголовок, если задан CRON_SECRET; без него принимаем только вызовы от планировщика Vercel
  const secret = process.env.CRON_SECRET;
  const ok = secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/.test(req.headers["user-agent"] || "");
  if (!ok) return res.status(401).end();
  try { res.status(200).json(await remindDebtors()); }
  catch (err) { console.error(err); res.status(500).json({ error: String(err.message || err) }); }
}
