// Raw visitor events for the dashboard: GET /api/stats  (Authorization: Bearer <STATS_PASSWORD>)
const { timingSafeEqual, createHash } = require('crypto')
const { pipeline } = require('./_redis')

function same(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest()
  return timingSafeEqual(h(a), h(b))
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex')
  const pw = process.env.STATS_PASSWORD
  if (!pw) return res.status(500).json({ error: 'STATS_PASSWORD is not set in Vercel environment variables' })
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!auth || !same(auth, pw)) {
    await new Promise((r) => setTimeout(r, 800)) // slow down guessing
    return res.status(401).json({ error: 'Wrong password' })
  }
  try {
    const limit = Math.min(50000, Math.max(1, Number(req.query.limit) || 20000))
    const [rows] = await pipeline([['LRANGE', 'sso:events', 0, limit - 1]])
    const events = []
    for (const r of rows || []) {
      try {
        events.push(JSON.parse(r))
      } catch {
        /* skip */
      }
    }
    res.status(200).json({ events })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
