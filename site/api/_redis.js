// Minimal Upstash Redis REST client (no dependencies).
// Works with the env vars that Vercel's Upstash / KV integration creates.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

function configured() {
  return !!(URL_ && TOKEN)
}

async function pipeline(commands) {
  if (!configured()) throw new Error('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing)')
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  })
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`)
  const out = await r.json()
  for (const x of out) if (x && x.error) throw new Error(`Redis: ${x.error}`)
  return out.map((x) => x.result)
}

module.exports = { pipeline, configured }
