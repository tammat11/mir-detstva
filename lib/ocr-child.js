// Отдельный процесс для чтения квитанции: если распознавание упадёт, бот продолжит работать
import { readReceipt } from "./ocr.js";

process.on("message", async ({ b64, type }) => {
  let r = null;
  try { r = await readReceipt(Buffer.from(b64, "base64"), type); } catch (e) { console.error(e); }
  process.send({ r }, () => process.exit(0));
});
