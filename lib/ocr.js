// Бесплатное распознавание квитанций: Tesseract (OCR) прямо на сервере, без внешних сервисов.
import path from "node:path";
import { fileURLToPath } from "node:url";

// словари rus + eng (tessdata_best_int) лежат рядом, в lib/tessdata
const LANG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "tessdata");
let workerPromise = null;

// Один распознаватель на «тёплую» функцию — второй и следующие запросы быстрее
function worker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      // errorHandler — иначе tesseract.js роняет весь процесс на битой картинке
      const w = await createWorker(["rus", "eng"], 1, { langPath: LANG_DIR, cacheMethod: "none", gzip: true, errorHandler: e => console.error("OCR worker:", e) });
      await w.setParameters({ tessedit_pageseg_mode: "3" }); // авто-разметка — находит и крупную сумму
      return w;
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

async function pdfToPng(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    // если в PDF есть текст — берём его как есть, без распознавания
    const tc = await page.getTextContent();
    const text = tc.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("").trim();
    if (/\d/.test(text) && text.length > 30) return { text };
    const vp = page.getViewport({ scale: 2.5 });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({ canvasContext: context, viewport: vp }).promise;
    return { png: canvas.toBuffer("image/png") };
  } finally {
    doc.destroy();
  }
}

// JPEG, PNG, WebP — по первым байтам файла
const isImage = b => b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"));

export async function readText(bytes, type) {
  let img = Buffer.from(bytes);
  if (type === "application/pdf") {
    const r = await pdfToPng(bytes);
    if (r.text) return r.text;
    img = r.png;
  }
  if (!isImage(img)) throw new Error("not an image");
  const w = await worker();
  const { data } = await w.recognize(Buffer.from(img));
  return data.text || "";
}

// ---------- разбор текста квитанции (Kaspi и похожие) ----------

const AMOUNT = /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:₸|тг|kzt|т|t)(?![a-zа-яё])/i;
const LABELS = /^(тип|№|номер|дата|время|по астане|комисс|отправит|откуда|куда|получат|статус|сумма|телефон|карта|счёт|счет|назначен)/i;

export function parseReceipt(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const r = {};
  const all = lines.join("\n");
  r.success = /успешно|выполнен|исполнен|оплачен/i.test(all) ? true : /отклон|ошибк|не выполн/i.test(all) ? false : null;

  // сумма: первая строка с числом и ₸, кроме комиссии
  let amountLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/комисс/i.test(lines[i])) continue;
    const m = lines[i].match(AMOUNT);
    if (m) { r.amount = Number(m[1].replace(/\D/g, "")) + (m[2] ? Number("0." + m[2]) : 0); amountLine = i; break; }
  }
  if (!r.amount) {
    const s = all.match(/сумма[^\d\n]*(\d[\d  ]*)/i);
    if (s) r.amount = Number(s[1].replace(/\D/g, ""));
  }

  // номер квитанции: цифры после «квитанции», иногда переносятся на следующую строку
  const qi = lines.findIndex(l => /квитанц|чек №|№ ?чека/i.test(l));
  if (qi >= 0) {
    let digits = (lines[qi].split(/квитанц\S*|чек/i).pop() || "").replace(/\D/g, "");
    for (let j = qi + 1; j < lines.length && /^[\d ]+$/.test(lines[j]); j++) digits += lines[j].replace(/\D/g, "");
    if (digits.length >= 6) r.receiptNo = digits;
  }

  const d = all.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\D{0,5}(\d{1,2}):(\d{2}))?/);
  if (d) r.date = `${d[3]}-${d[2]}-${d[1]}` + (d[4] ? ` ${d[4].padStart(2, "0")}:${d[5]}` : "");

  const val = re => { const m = all.match(re); return m ? m[1].trim().slice(0, 60) : undefined; };
  r.sender = val(/Отправитель[:\s]+([^\n]+)/i);
  r.recipient = val(/Получатель[:\s]+([^\n]+)/i);
  // у переводов Kaspi получатель — строка сразу под суммой
  if (!r.recipient && amountLine >= 0) {
    const next = lines[amountLine + 1];
    if (next && /[A-Za-zА-Яа-яЁё]/.test(next) && !LABELS.test(next) && !AMOUNT.test(next)) r.recipient = next.slice(0, 60);
  }
  r.bank = /kaspi/i.test(all) ? "Kaspi" : /halyk/i.test(all) ? "Halyk" : /jusan/i.test(all) ? "Jusan" : /freedom/i.test(all) ? "Freedom" : undefined;

  for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === null) delete r[k];
  return r.amount || r.receiptNo ? r : null;
}

// Прочитать квитанцию; любые сбои распознавания не ломают приём квитанции
export async function readReceipt(bytes, type, timeoutMs = 20000) {
  try {
    const text = await Promise.race([readText(bytes, type), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return parseReceipt(text);
  } catch (e) {
    console.error("OCR:", e && e.message);
    return null;
  }
}
