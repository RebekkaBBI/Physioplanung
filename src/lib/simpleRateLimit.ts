/**
 * Einfaches In-Memory Sliding-Window-Limit (pro Node-Prozess).
 * Unter Vercel Serverless: Schutz vor kurzfristigen Bursts pro Instanz — kein globaler Zähler über alle Instanzen.
 */
const buckets = new Map<string, number[]>()

export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now()
  const stamps = buckets.get(key)?.filter((t) => now - t < windowMs) ?? []
  if (stamps.length >= max) {
    buckets.set(key, stamps)
    return false
  }
  stamps.push(now)
  buckets.set(key, stamps)
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.length === 0 || v.every((t) => now - t >= windowMs)) {
        buckets.delete(k)
      }
    }
  }
  return true
}

export function getRequestClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  return 'unknown'
}
