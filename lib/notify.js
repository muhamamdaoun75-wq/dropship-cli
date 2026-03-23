// Notify — Send alerts via Slack/Discord webhooks
// Lightweight notification system for critical business events
import axios from 'axios'
import config from './config.js'

// ── Send to Slack webhook ───────────────────────────────────────────────────
async function sendSlack(webhookUrl, message, opts = {}) {
  const payload = {
    text: message,
    username: opts.username || 'Dropship CLI',
    icon_emoji: opts.emoji || ':robot_face:'
  }

  if (opts.blocks) payload.blocks = opts.blocks

  await axios.post(webhookUrl, payload, { timeout: 10000 })
}

// ── Send to Discord webhook ─────────────────────────────────────────────────
async function sendDiscord(webhookUrl, message, opts = {}) {
  const payload = {
    content: message,
    username: opts.username || 'Dropship CLI'
  }

  if (opts.embeds) payload.embeds = opts.embeds

  await axios.post(webhookUrl, payload, { timeout: 10000 })
}

// ── Universal alert sender ──────────────────────────────────────────────────
async function sendAlert(message, opts = {}) {
  const results = []
  const slackUrl = config.getWebhook('slack')
  const discordUrl = config.getWebhook('discord')

  if (slackUrl) {
    try {
      await sendSlack(slackUrl, message, opts)
      results.push({ channel: 'slack', sent: true })
    } catch (err) {
      results.push({ channel: 'slack', sent: false, error: err.message })
    }
  }

  if (discordUrl) {
    try {
      await sendDiscord(discordUrl, message, opts)
      results.push({ channel: 'discord', sent: true })
    } catch (err) {
      results.push({ channel: 'discord', sent: false, error: err.message })
    }
  }

  if (results.length === 0) {
    results.push({ channel: 'none', sent: false, error: 'No webhooks configured. Run: dropship notify --setup' })
  }

  return results
}

// ── Format business alert ───────────────────────────────────────────────────
function formatAlert(type, data) {
  const icons = {
    order: '🛒',
    stockout: '🔴',
    refund: '💸',
    revenue: '💰',
    threat: '⚠️',
    success: '✅',
    error: '❌',
    info: 'ℹ️'
  }

  const icon = icons[type] || '📢'
  const timestamp = new Date().toLocaleString()
  const shop = config.getShop() || 'your store'

  let msg = `${icon} **${type.toUpperCase()}** — ${shop}\n`
  msg += data.message || ''
  if (data.details) msg += `\n${data.details}`
  msg += `\n_${timestamp}_`

  return msg
}

export { sendSlack, sendDiscord, sendAlert, formatAlert }
export default { sendSlack, sendDiscord, sendAlert, formatAlert }
