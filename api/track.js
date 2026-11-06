import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Keep production stats clean: dev/preview writes land under a separate prefix.
const PREFIX = process.env.VERCEL_ENV === 'production' ? 'squeeze:analytics' : 'squeeze:dev:analytics';

function qualityBucket(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return 'unknown';
  if (n <= 30) return '1-30';
  if (n <= 45) return '31-45';
  if (n <= 60) return '46-60';
  if (n <= 75) return '61-75';
  if (n <= 90) return '76-90';
  return '91-100';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let ops = [];
  try {
    const {
      type,
      count = 0,
      originalBytes = 0,
      compressedBytes = 0,
      durationMs = 0,
      formats = {},
      quality,
      device,
      error,
    } = req.body || {};

    const today = new Date().toISOString().slice(0, 10);

    if (type === 'compress_complete' && count > 0) {
      ops.push(redis.incrby(`${PREFIX}:total_images`, count));
      ops.push(redis.incrby(`${PREFIX}:daily:${today}`, count));
      ops.push(redis.expire(`${PREFIX}:daily:${today}`, 60 * 60 * 24 * 90));

      if (originalBytes > 0) ops.push(redis.incrby(`${PREFIX}:total_original_bytes`, originalBytes));
      if (compressedBytes > 0) ops.push(redis.incrby(`${PREFIX}:total_compressed_bytes`, compressedBytes));

      if (originalBytes > 0 && compressedBytes >= 0) {
        const savedPct = Math.round((1 - compressedBytes / originalBytes) * 100);
        ops.push(redis.lpush(`${PREFIX}:savings`, savedPct));
        ops.push(redis.ltrim(`${PREFIX}:savings`, 0, 499));
      }

      for (const [fmt, n] of Object.entries(formats)) {
        if (n > 0) ops.push(redis.hincrby(`${PREFIX}:formats`, fmt, n));
      }

      if (quality !== undefined) ops.push(redis.hincrby(`${PREFIX}:quality`, qualityBucket(quality), 1));

      if (durationMs > 0) {
        // store per-image average so the metric stays comparable across batch sizes
        ops.push(redis.lpush(`${PREFIX}:durations`, Math.round(durationMs / count)));
        ops.push(redis.ltrim(`${PREFIX}:durations`, 0, 499));
      }
    }

    if (device) ops.push(redis.hincrby(`${PREFIX}:devices`, device, 1));
    if (type === 'compress_fail' && error) {
      ops.push(redis.hincrby(`${PREFIX}:errors`, String(error).slice(0, 80), 1));
    }

  } catch (e) {
    // The payload was malformed enough that we could not even build the writes.
    // Any commands already issued are in flight; swallow their results so they
    // cannot surface as unhandled rejections after we have responded.
    ops.forEach((p) => Promise.resolve(p).catch(() => {}));
    console.error('track: bad request payload:', e);
    return res.status(400).json({ ok: false, error: 'bad_payload' });
  }

  // allSettled rather than all: one failing counter should not discard the
  // rest, and we want to know exactly which writes were lost.
  const results = await Promise.allSettled(ops);
  const failed = results.filter((r) => r.status === 'rejected');

  if (failed.length) {
    console.error(
      `track: ${failed.length}/${results.length} Redis writes failed;` +
      ` first error: ${failed[0].reason?.message || failed[0].reason}`
    );
    // The client sends these fire-and-forget and ignores the response, but a
    // non-2xx keeps the failure visible in logs and uptime checks instead of
    // silently losing analytics.
    return res.status(500).json({ ok: false, error: 'write_failed', failed: failed.length });
  }

  res.status(200).json({ ok: true, writes: results.length });
}
