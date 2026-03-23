// Copy Skill — AI copywriting for product descriptions, titles, and SEO
// AI agent that rewrites product listings to convert better
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Copywriter Agent — you make products irresistible.

Your job: Rewrite product titles, descriptions, and meta tags to maximize conversions and SEO.

## Copywriting Rules
1. TITLES: Clear, benefit-driven, under 70 characters. Include primary keyword.
   - BAD: "Product X-200 Black" → GOOD: "Ultra-Thin LED Desk Lamp - Touch Dimmer, USB Charging"
2. DESCRIPTIONS: Benefit-first, scannable, use bullet points. Address objections.
   - Lead with the #1 benefit
   - 3-5 bullet points for features
   - Include social proof language ("loved by 10,000+ customers")
   - End with a clear CTA
3. SEO META: Title under 60 chars, description under 155 chars, natural keyword usage.
4. Never use fake claims or misleading language.
5. Match the store's existing tone/voice when possible.

## Process
1. Audit existing product listings for weak copy
2. Rewrite the worst performers first (products with views but no sales)
3. Generate SEO-optimized meta tags
4. Apply changes via Shopify API
5. Report what was updated

Focus on products that will benefit most from better copy.`

const tools = [
  {
    name: 'get_products_for_copy',
    description: 'Get products that need copy improvements.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const products = await shopify.getProducts({ status: 'active', fields: 'id,title,body_html,product_type,tags,variants,images' })

        const needsCopy = products.map(p => {
          const issues = []
          if (!p.body_html || p.body_html.length < 50) issues.push('missing_description')
          if (p.title && p.title.length > 80) issues.push('title_too_long')
          if (p.title && p.title === p.title.toUpperCase()) issues.push('all_caps_title')
          if (!p.body_html?.includes('<')) issues.push('no_html_formatting')
          if (!p.tags || p.tags.length === 0) issues.push('no_tags')
          if (p.body_html?.includes('Lorem') || p.body_html?.includes('lorem')) issues.push('placeholder_text')

          return {
            id: p.id,
            title: p.title,
            currentDescription: (p.body_html || '').replace(/<[^>]*>/g, '').slice(0, 300),
            descriptionLength: (p.body_html || '').length,
            type: p.product_type,
            tags: p.tags,
            price: p.variants?.[0]?.price,
            hasImages: (p.images || []).length > 0,
            issues,
            priority: issues.length
          }
        }).sort((a, b) => b.priority - a.priority)

        return {
          totalProducts: products.length,
          needsWork: needsCopy.filter(p => p.priority > 0).length,
          products: needsCopy.slice(0, 15)
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'update_product_copy',
    description: 'Update a product title and/or description in Shopify.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'number' },
        title: { type: 'string', description: 'New product title (omit to keep current)' },
        bodyHtml: { type: 'string', description: 'New HTML description (omit to keep current)' },
        tags: { type: 'string', description: 'Comma-separated tags for SEO' },
        metaTitle: { type: 'string', description: 'SEO meta title (under 60 chars)' },
        metaDescription: { type: 'string', description: 'SEO meta description (under 155 chars)' }
      },
      required: ['productId']
    },
    async execute(input) {
      try {
        const update = {}
        if (input.title) update.title = input.title
        if (input.bodyHtml) update.body_html = input.bodyHtml
        if (input.tags) update.tags = input.tags
        if (input.metaTitle) update.metafields_global_title_tag = input.metaTitle
        if (input.metaDescription) update.metafields_global_description_tag = input.metaDescription

        await shopify.updateProduct(input.productId, update)
        logger.success(`Updated: ${input.title || `Product #${input.productId}`}`)

        await db.logAction({
          shop: config.getShop(),
          type: 'COPY_UPDATE',
          message: `Updated copy for product ${input.productId}`,
          metadata: { productId: input.productId, fields: Object.keys(update) }
        })

        return { updated: true, productId: input.productId }
      } catch (err) {
        return { updated: false, error: err.message }
      }
    }
  },
  {
    name: 'present_copy_report',
    description: 'Show the copywriting report.',
    inputSchema: {
      type: 'object',
      properties: {
        productsAudited: { type: 'number' },
        productsUpdated: { type: 'number' },
        issuesFixed: { type: 'number' },
        updates: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, changes: { type: 'string' } } } },
        recommendations: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      },
      required: ['summary']
    },
    async execute(input) {
      logger.header('Copywriting Report')
      if (input.productsAudited) logger.kv('Products Audited', input.productsAudited)
      if (input.productsUpdated) logger.kv('Products Updated', input.productsUpdated)
      if (input.issuesFixed) logger.kv('Issues Fixed', input.issuesFixed)

      if (input.updates?.length) {
        logger.blank()
        logger.bold('Updates Made')
        for (const u of input.updates) {
          logger.item(`${u.title} — ${u.changes}`)
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
  logger.header('AI Copywriter')
  logger.spin('Auditing product listings...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Audit all product listings. Identify products with weak titles, missing descriptions, or no SEO tags. Rewrite the worst ones with compelling, conversion-optimized copy. Update them in Shopify. Present a report.',
    tools,
    maxIterations: 15,
    onAction(name) {
      if (name === 'get_products_for_copy') logger.spin('Auditing listings...')
      if (name === 'update_product_copy') logger.spin('Updating copy...')
    }
  })

  logger.stopSpin(result.success ? 'Copywriting complete' : 'Copywriting failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
