// Config — Store credentials, API keys, persistent config
// Uses `conf` package so config survives restarts
import Conf from 'conf'
import dotenv from 'dotenv'

dotenv.config()

const store = new Conf({
  projectName: 'dropship-cli',
  schema: {
    shopify: {
      type: 'object',
      properties: {
        shop: { type: 'string' },
        accessToken: { type: 'string' },
        apiVersion: { type: 'string', default: '2024-10' }
      }
    },
    supabase: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        key: { type: 'string' }
      }
    },
    anthropic: {
      type: 'object',
      properties: {
        apiKey: { type: 'string' }
      }
    },
    cj: {
      type: 'object',
      properties: {
        apiKey: { type: 'string' },
        token: { type: 'string' },
        tokenExpiry: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' }
      }
    },
    license: {
      type: 'object',
      properties: {
        key: { type: 'string' }
      }
    },
    usage: {
      type: 'object'
    },
    webhooks: {
      type: 'object',
      properties: {
        slack: { type: 'string' },
        discord: { type: 'string' }
      }
    },
    productMappings: {
      type: 'object'
    }
  }
})

const config = {
  // Shopify
  getShop() {
    return store.get('shopify.shop') || process.env.SHOPIFY_SHOP || null
  },
  getShopifyToken() {
    return store.get('shopify.accessToken') || process.env.SHOPIFY_ACCESS_TOKEN || null
  },
  getShopifyApiVersion() {
    return store.get('shopify.apiVersion') || process.env.SHOPIFY_API_VERSION || '2024-10'
  },
  setShopify({ shop, accessToken }) {
    store.set('shopify.shop', shop)
    store.set('shopify.accessToken', accessToken)
  },

  // Supabase
  getSupabaseUrl() {
    return store.get('supabase.url') || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null
  },
  getSupabaseKey() {
    return store.get('supabase.key') || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || null
  },
  setSupabase({ url, key }) {
    store.set('supabase.url', url)
    store.set('supabase.key', key)
  },

  // Anthropic
  getAnthropicKey() {
    return store.get('anthropic.apiKey') || process.env.ANTHROPIC_API_KEY || null
  },
  setAnthropicKey(key) {
    store.set('anthropic.apiKey', key)
  },

  // CJ Dropshipping
  getCJApiKey() {
    return store.get('cj.apiKey') || process.env.CJ_API_KEY || null
  },
  getCJToken() {
    return store.get('cj.token') || null
  },
  getCJTokenExpiry() {
    return store.get('cj.tokenExpiry') || null
  },
  getCJEmail() {
    return store.get('cj.email') || process.env.CJ_EMAIL || null
  },
  getCJPassword() {
    return store.get('cj.password') || process.env.CJ_PASSWORD || null
  },
  setCJ({ apiKey, token, tokenExpiry, email, password }) {
    if (apiKey) store.set('cj.apiKey', apiKey)
    if (token) store.set('cj.token', token)
    if (tokenExpiry) store.set('cj.tokenExpiry', tokenExpiry)
    if (email) store.set('cj.email', email)
    if (password) store.set('cj.password', password)
  },
  clearCJToken() {
    store.delete('cj.token')
    store.delete('cj.tokenExpiry')
  },

  // License
  getLicenseKey() {
    return store.get('license.key') || process.env.DROPSHIP_LICENSE_KEY || null
  },
  setLicenseKey(key) {
    store.set('license.key', key)
  },
  removeLicenseKey() {
    store.delete('license.key')
  },

  // Usage tracking (monthly counters for free tier limits)
  getUsage(monthKey) {
    return store.get(`usage.${monthKey}`) || {}
  },
  incrementUsage(monthKey, type) {
    const usage = this.getUsage(monthKey)
    usage[type] = (usage[type] || 0) + 1
    store.set(`usage.${monthKey}`, usage)
  },

  // Webhooks (Slack/Discord notifications)
  getWebhook(channel) {
    return store.get(`webhooks.${channel}`) || null
  },
  setWebhook(channel, url) {
    store.set(`webhooks.${channel}`, url)
  },
  removeWebhook(channel) {
    store.delete(`webhooks.${channel}`)
  },
  getWebhooks() {
    return store.get('webhooks') || {}
  },

  // Product Mappings — CJ product ID → Shopify product ID
  // Persisted so fulfill knows which CJ product to order for each Shopify product
  getProductMappings() {
    return store.get('productMappings') || {}
  },
  setProductMapping(shopifyProductId, { cjProductId, cjVariantId, supplierPrice, title }) {
    const key = `productMappings.${shopifyProductId}`
    store.set(key, { cjProductId, cjVariantId, supplierPrice, title, mappedAt: new Date().toISOString() })
  },
  getProductMapping(shopifyProductId) {
    return store.get(`productMappings.${shopifyProductId}`) || null
  },
  removeProductMapping(shopifyProductId) {
    store.delete(`productMappings.${shopifyProductId}`)
  },

  // Check if connected
  isConnected() {
    return !!(this.getShop() && this.getShopifyToken())
  },

  // Check if all required keys are set
  isConfigured() {
    return !!(this.getShop() && this.getShopifyToken() && this.getAnthropicKey())
  },

  // Get full config summary (safe — no secrets)
  summary() {
    return {
      shop: this.getShop() || '(not set)',
      shopifyConnected: !!this.getShopifyToken(),
      supabaseConnected: !!(this.getSupabaseUrl() && this.getSupabaseKey()),
      anthropicConnected: !!this.getAnthropicKey(),
      cjConnected: !!(this.getCJApiKey() || (this.getCJEmail() && this.getCJPassword()))
    }
  },

  // Reset everything
  reset() {
    store.clear()
  },

  // Raw access for advanced use
  raw: store
}

export default config
