function getDeviceType() {
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk|(android(?!.*mobi))/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function track(type, payload = {}) {
  try {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, device: getDeviceType(), ts: Date.now(), ...payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
