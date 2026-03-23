// Legal Skill — Generate legal pages and check compliance
// AI agent that creates privacy policy, terms, refund policy for the store
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Legal Agent — you protect the business from legal risk.

Your job: Generate legally sound store policies and check for compliance gaps.

## Pages You Generate
1. **Privacy Policy** — GDPR/CCPA compliant, covers data collection, cookies, third-party sharing
2. **Terms of Service** — Covers purchases, intellectual property, liability limits, disputes
3. **Refund & Return Policy** — Clear return window, conditions, refund method, exceptions
4. **Shipping Policy** — Delivery times (dropshipping-appropriate), international shipping, tracking

## Compliance Checks
- All required legal pages exist and are accessible
- Privacy policy covers all data collection (Shopify, analytics, email, payment)
- Refund policy matches actual business practices
- Contact information is visible
- Cookie consent banner recommendation
- Age restriction if selling age-restricted products

## Rules
- Policies should be readable, not legalese — customers need to understand them
- Include the store name and contact email dynamically
- Dropshipping-specific: explain "ships from multiple warehouses" to set delivery expectations
- Include date of last update
- Always recommend professional legal review for final versions

Generate real, usable policies — not templates.`

const tools = [
  {
    name: 'get_store_details',
    description: 'Get store info needed for legal pages.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const [shop, products] = await Promise.all([
          shopify.getShopInfo(),
          shopify.getProducts({ status: 'active', fields: 'id,title,product_type' })
        ])

        const categories = [...new Set(products.map(p => p.product_type).filter(Boolean))]

        return {
          storeName: shop.name,
          domain: shop.domain,
          email: shop.email,
          country: shop.country_name || shop.country,
          currency: shop.currency,
          productCount: products.length,
          categories,
          plan: shop.plan_display_name
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'check_existing_pages',
    description: 'Check which legal pages already exist on the store.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const pages = await shopify.shopifyFetch('/pages.json?limit=250')
        const existingPages = (pages.pages || []).map(p => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          published: p.published_at !== null,
          bodyLength: (p.body_html || '').length
        }))

        const legalKeywords = ['privacy', 'terms', 'refund', 'return', 'shipping', 'policy', 'legal']
        const legalPages = existingPages.filter(p =>
          legalKeywords.some(k => p.title.toLowerCase().includes(k) || p.handle.includes(k))
        )

        return {
          totalPages: existingPages.length,
          legalPages,
          hasPrivacyPolicy: legalPages.some(p => p.handle.includes('privacy')),
          hasTerms: legalPages.some(p => p.handle.includes('terms')),
          hasRefundPolicy: legalPages.some(p => p.handle.includes('refund') || p.handle.includes('return')),
          hasShippingPolicy: legalPages.some(p => p.handle.includes('shipping'))
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'create_legal_page',
    description: 'Create or update a legal page on the Shopify store.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title (e.g. "Privacy Policy")' },
        handle: { type: 'string', description: 'URL handle (e.g. "privacy-policy")' },
        bodyHtml: { type: 'string', description: 'Full HTML content of the policy' },
        published: { type: 'boolean', default: true }
      },
      required: ['title', 'bodyHtml']
    },
    async execute(input) {
      try {
        const pageData = {
          title: input.title,
          body_html: input.bodyHtml,
          published: input.published !== false
        }
        if (input.handle) pageData.handle = input.handle

        await shopify.shopifyFetch('/pages.json', {
          method: 'POST',
          data: { page: pageData }
        })

        logger.success(`Created: ${input.title}`)

        await db.logAction({
          shop: config.getShop(),
          type: 'LEGAL_PAGE',
          message: `Created legal page: ${input.title}`,
          metadata: { title: input.title, handle: input.handle }
        })

        return { created: true, title: input.title }
      } catch (err) {
        return { created: false, error: err.message }
      }
    }
  },
  {
    name: 'present_legal_report',
    description: 'Show the legal compliance report.',
    inputSchema: {
      type: 'object',
      properties: {
        complianceScore: { type: 'number', description: '0-100' },
        pagesCreated: { type: 'number' },
        pagesExisting: { type: 'number' },
        gaps: { type: 'array', items: { type: 'object', properties: { area: { type: 'string' }, risk: { type: 'string' }, action: { type: 'string' } } } },
        recommendations: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      },
      required: ['complianceScore', 'summary']
    },
    async execute(input) {
      logger.header('Legal Compliance Report')

      const score = input.complianceScore
      const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F'
      const icon = score >= 75 ? '🟢' : score >= 50 ? '🟡' : '🔴'
      logger.bold(`Compliance: ${score}/100 ${icon} ${grade}`)
      logger.blank()

      if (input.pagesCreated) logger.kv('Pages Created', input.pagesCreated)
      if (input.pagesExisting) logger.kv('Pages Already Existed', input.pagesExisting)

      if (input.gaps?.length) {
        logger.blank()
        logger.bold('Compliance Gaps')
        for (const g of input.gaps) {
          logger.warn(`${g.area} — ${g.risk}`)
          if (g.action) logger.dim(`  → ${g.action}`)
        }
      }

      if (input.recommendations?.length) {
        logger.blank()
        logger.bold('Recommendations')
        for (const r of input.recommendations) logger.item(r)
      }

      logger.blank()
      logger.info(input.summary)
      return { displayed: true }
    }
  }
]

async function run() {
  logger.header('Legal Compliance')
  logger.spin('Checking legal pages...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Check which legal pages exist on the store. For any missing required pages (privacy, terms, refund, shipping), generate professional, store-specific policies and create them. Present a compliance report.',
    tools,
    maxIterations: 15,
    onAction(name) {
      if (name === 'get_store_details') logger.spin('Loading store info...')
      if (name === 'check_existing_pages') logger.spin('Checking existing pages...')
      if (name === 'create_legal_page') logger.spin('Creating policy page...')
    }
  })

  logger.stopSpin(result.success ? 'Legal check complete' : 'Legal check failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
