// License — Key validation, tier gating, usage tracking
// Offline HMAC-signed keys: no server needed for validation
// Format: DSC-{base64url_payload}.{signature}
import { createHmac } from 'crypto'
import config from './config.js'

const LICENSE_SECRET = process.env.DROPSHIP_LICENSE_SECRET || 'dsc-phantom-2024-v1'

// ── Tier Definitions ────────────────────────────────────────────────────────

const TIERS = {
  free: {
    name: 'Free',
    limits: {
      sourcesPerMonth: 3,
      scoutResults: 5,
      fulfillmentsPerMonth: 10,
      chatTurnsPerDay: 20,
      autopilot: false
    }
  },
  pro: {
    name: 'Pro',
    limits: {
      sourcesPerMonth: Infinity,
      scoutResults: Infinity,
      fulfillmentsPerMonth: Infinity,
      chatTurnsPerDay: Infinity,
      autopilot: true
    }
  }
}

// Commands available on free tier
const FREE_COMMANDS = ['connect', 'status', 'chat', 'scout', 'source', 'doctor', 'config', 'activate', 'legal', 'notify']

// Commands that require pro
const PRO_COMMANDS = ['price', 'fulfill', 'guard', 'analyze', 'segment', 'growth', 'support', 'audit', 'intel', 'supplier', 'forecast', 'profit', 'email', 'autopilot', 'returns', 'inventory', 'copy', 'reviews', 'upsell']

// ── Key Signing ─────────────────────────────────────────────────────────────

function sign(payload) {
  return createHmac('sha256', LICENSE_SECRET)
    .update(payload)
    .digest('base64url')
    .slice(0, 32)
}

// ── Generate a license key (used by us to create keys for customers) ────────

function generateKey(email, tier = 'pro', daysValid = 365) {
  if (!email || !email.includes('@')) throw new Error('Invalid email')
  if (!['free', 'pro'].includes(tier)) throw new Error('Invalid tier: must be free or pro')
  if (daysValid < 1 || daysValid > 3650) throw new Error('Invalid expiry: 1-3650 days')

  const exp = Date.now() + daysValid * 86400000
  const payload = Buffer.from(JSON.stringify({ email, tier, exp, v: 1 })).toString('base64url')
  const sig = sign(payload)
  return `DSC-${payload}.${sig}`
}

// ── Validate a license key ──────────────────────────────────────────────────

function validateKey(key) {
  if (!key || !key.startsWith('DSC-')) {
    return { valid: false, tier: 'free', reason: 'Invalid key format' }
  }

  try {
    const body = key.slice(4)
    const dotIdx = body.lastIndexOf('.')
    if (dotIdx === -1) return { valid: false, tier: 'free', reason: 'Malformed key' }

    const payload = body.slice(0, dotIdx)
    const sig = body.slice(dotIdx + 1)

    if (!payload || !sig) {
      return { valid: false, tier: 'free', reason: 'Malformed key' }
    }

    // Verify signature
    const expectedSig = sign(payload)
    if (sig !== expectedSig) {
      return { valid: false, tier: 'free', reason: 'Invalid signature' }
    }

    // Decode payload
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())

    // Check expiry
    if (data.exp && data.exp < Date.now()) {
      return { valid: false, tier: 'free', reason: 'License expired', email: data.email }
    }

    return {
      valid: true,
      tier: data.tier || 'pro',
      email: data.email,
      expiresAt: new Date(data.exp)
    }
  } catch {
    return { valid: false, tier: 'free', reason: 'Corrupt key' }
  }
}

// ── Get current tier ────────────────────────────────────────────────────────

function getTier() {
  const key = config.getLicenseKey()
  if (!key) return { tier: 'free', ...TIERS.free }

  const result = validateKey(key)
  if (result.valid && result.tier === 'pro') {
    return { tier: 'pro', ...TIERS.pro, email: result.email, expiresAt: result.expiresAt }
  }

  return { tier: 'free', ...TIERS.free, reason: result.reason }
}

// ── Command access check ────────────────────────────────────────────────────

function isCommandAllowed(command) {
  const { tier } = getTier()
  if (tier === 'pro') return true
  return FREE_COMMANDS.includes(command)
}

// ── Usage tracking (monthly) ────────────────────────────────────────────────

function _monthKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getUsage(type) {
  const usage = config.getUsage(_monthKey())
  return usage[type] || 0
}

function incrementUsage(type) {
  config.incrementUsage(_monthKey(), type)
}

function checkLimit(type) {
  const { tier, limits } = getTier()
  if (tier === 'pro') return { allowed: true, remaining: Infinity }

  const used = getUsage(type)
  const limit = limits[type]

  if (typeof limit === 'boolean') return { allowed: limit, remaining: limit ? Infinity : 0 }
  if (typeof limit !== 'number' || !isFinite(limit)) return { allowed: true, remaining: Infinity }

  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used)
  }
}

export {
  generateKey,
  validateKey,
  getTier,
  isCommandAllowed,
  getUsage,
  incrementUsage,
  checkLimit,
  FREE_COMMANDS,
  PRO_COMMANDS,
  TIERS
}

export default {
  generateKey, validateKey, getTier, isCommandAllowed,
  getUsage, incrementUsage, checkLimit,
  FREE_COMMANDS, PRO_COMMANDS, TIERS
}
