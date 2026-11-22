// Visitor event collector: POST /api/e  (sent with navigator.sendBeacon from index.html)
const { pipeline } = require('./_redis')

const KEY = 'sso:events'
const MAX_EVENTS = 50000 // oldest events are dropped beyond this
const TYPES = new Set(['view', 'section', 'download', 'click', 'leave'])
const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|go-http/i

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}
function num(v, min, max) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined
}
function header(req, name) {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}
function decode(v) {
  try {
    return v ? decodeURIComponent(v) : undefined
  } catch {
    return v
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    let body = req.body
    if (typeof body === 'string') body = JSON.parse(body.slice(0, 4000))
    if (!body || typeof body !== 'object' || !TYPES.has(body.t)) return res.status(204).end()

    const ua = str(header(req, 'user-agent'), 300) || ''
    if (BOT_RE.test(ua)) return res.status(204).end()

    const ip = (header(req, 'x-forwarded-for') || header(req, 'x-real-ip') || '').split(',')[0].trim() || 'unknown'
    const ev = {
      ts: Date.now(),
      t: body.t,
      vid: str(body.vid, 40), // visitor id (localStorage)
      sid: str(body.sid, 40), // page-view id
      ip,
      country: header(req, 'x-vercel-ip-country'),
      region: decode(header(req, 'x-vercel-ip-country-region')),
      city: decode(header(req, 'x-vercel-ip-city')),
      ua,
      ref: str(body.ref, 300),
      path: str(body.path, 200),
      utm: str(body.utm, 200),
      lang: str(body.lang, 20),
      screen: str(body.screen, 20),
      target: str(body.target, 60), // download/click target or section id
      href: str(body.href, 300),
      scroll: num(body.scroll, 0, 100), // max scroll depth %
      dur: num(body.dur, 0, 86400), // seconds on page
      sections: Array.isArray(body.sections) ? body.sections.slice(0, 10).map((s) => str(s, 30)).filter(Boolean) : undefined
    }
    await pipeline([
      ['LPUSH', KEY, JSON.stringify(ev)],
      ['LTRIM', KEY, 0, MAX_EVENTS - 1]
    ])
    res.status(204).end()
  } catch (e) {
    console.error('[track]', e && e.message)
    res.status(204).end() // never break the page
  }
}
