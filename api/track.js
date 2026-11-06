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
    const ops = [];

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

    await Promise.all(ops);
  } catch {}
  res.status(200).json({ ok: true });
}
