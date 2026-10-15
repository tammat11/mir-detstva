// Хранилище на Vercel Blob (приватное). Данные — несколько JSON-файлов, квитанции — отдельные файлы.
import { put, get, head, del, BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readRaw(path, withEtag) {
  try {
    // метку версии берём из head(): её же Vercel сверяет при записи с ifMatch
    // (etag из get() — это HTTP-заголовок, он в другом формате и не совпадает)
    const meta = withEtag ? await head(path) : null;
    const r = await get(path, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return { data: null, etag: null };
    return { data: JSON.parse(await new Response(r.stream).text()), etag: meta ? meta.etag : null };
  } catch (e) {
    if (e instanceof BlobNotFoundError) return { data: null, etag: null };
    throw e;
  }
}

export async function read(path, fallback) {
  const { data } = await readRaw(path);
  return data ?? structuredClone(fallback);
}

// Прочитать → изменить → записать. Если файл успел измениться (два запроса одновременно) — повторяем.
export async function update(path, fallback, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await readRaw(path, true);
    const data = cur.data ?? structuredClone(fallback);
    const result = await fn(data);
    // последняя попытка — без проверки версии: лучше сохранить, чем потерять квитанцию
    const guard = cur.etag && i < 5 ? { ifMatch: cur.etag } : {};
    try {
      await put(path, JSON.stringify(data), {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: true, cacheControlMaxAge: 60, ...guard,
      });
      return result;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) { await sleep(80 * (i + 1) + Math.random() * 100); continue; }
      throw e;
    }
  }
  throw new Error("Не удалось сохранить, попробуйте ещё раз");
}

export async function saveFile(path, bytes, contentType) {
  await put(path, bytes, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true });
  return path;
}

export async function readFile(path) {
  const r = await get(path, { access: "private" });
  if (!r || r.statusCode !== 200) return null;
  return { bytes: Buffer.from(await new Response(r.stream).arrayBuffer()), contentType: r.blob.contentType };
}

export async function removeFile(path) {
  try { await del(path); } catch (e) { /* уже удалён */ }
}
