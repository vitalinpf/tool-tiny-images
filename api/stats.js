import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const PREFIX = process.env.VERCEL_ENV === 'production' ? 'squeeze:analytics' : 'squeeze:dev:analytics';

export default async function handler(req, res) {
  try {
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (29 - i));
      return d.toISOString().slice(0, 10);
    });

    const [
      totalImages, totalOriginal, totalCompressed,
      formats, devices, quality, errors,
      durations, savings,
      ...dailyVals
    ] = await Promise.all([
      redis.get(`${PREFIX}:total_images`),
      redis.get(`${PREFIX}:total_original_bytes`),
      redis.get(`${PREFIX}:total_compressed_bytes`),
      redis.hgetall(`${PREFIX}:formats`),
      redis.hgetall(`${PREFIX}:devices`),
      redis.hgetall(`${PREFIX}:quality`),
      redis.hgetall(`${PREFIX}:errors`),
      redis.lrange(`${PREFIX}:durations`, 0, 499),
      redis.lrange(`${PREFIX}:savings`, 0, 499),
      ...dates.map((d) => redis.get(`${PREFIX}:daily:${d}`)),
    ]);

    const avg = (arr) => (arr?.length ? Math.round(arr.reduce((a, b) => a + Number(b), 0) / arr.length) : 0);

    const errList = Object.entries(errors || {})
      .map(([type, count]) => ({
        type,
        count: Number(count),
        severity: count > 10 ? 'high' : count > 5 ? 'med' : 'low',
        lastSeen: '最近',
      }))
      .sort((a, b) => b.count - a.count);

    res.status(200).json({
      totalImages: Number(totalImages) || 0,
      totalOriginalBytes: Number(totalOriginal) || 0,
      totalCompressedBytes: Number(totalCompressed) || 0,
      avgSavingsPct: avg(savings),
      avgDurationMs: avg(durations),
      formats: formats || {},
      devices: devices || {},
      quality: quality || {},
      errors: errList,
      daily: dates.map((date, i) => ({
        date: new Date(date).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' }),
        count: Number(dailyVals[i]) || 0,
      })),
    });
  } catch (e) {
    // Stats are unavailable (usually Redis is unreachable or unconfigured).
    // Return an explicit failure rather than invented numbers — a dashboard
    // showing fabricated traffic is worse than one showing nothing.
    console.error('stats: failed to read from Redis:', e);
    res.status(503).json({ available: false, error: 'stats_unavailable' });
  }
}
