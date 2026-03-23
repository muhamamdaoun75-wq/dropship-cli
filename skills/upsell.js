// Upsell Skill — Cross-sell/upsell automation and bundle recommendations
// AI agent that finds revenue opportunities in existing customer data
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Upsell Agent — you find money left on the table.

Your job: Analyze purchase patterns to create upsell/cross-sell recommendations and bundle strategies.

## What You Look For
1. **Frequently Bought Together** — Products that appear in the same orders
2. **Sequential Purchases** — Products customers buy in sequence (natural upsell path)
3. **Bundle Opportunities** — 2-3 products that work as a discounted bundle
4. **Price Gap Upsells** — When a customer buys cheap, what premium alternative could they want?
5. **Post-Purchase Offers** — After buying X, customers likely need Y

## Analysis Methods
- Co-occurrence analysis: Which products appear together in orders?
- Customer journey mapping: What do repeat customers buy next?
- AOV optimization: How to increase average order value
- Category affinity: Which categories have cross-sell potential?

## Output
- Specific product pair recommendations with expected revenue uplift
- Bundle suggestions with pricing
- Post-purchase sequence recommendations
- Priority-ranked by potential revenue impact

Be data-driven. Show which products pair together and how much revenue each opportunity represents.`

const tools = [
  {
    name: 'analyze_purchase_patterns',
    description: 'Analyze order data for co-purchase patterns and upsell opportunities.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const [orders, products] = await Promise.all([
          shopify.getOrders({ limit: '250', status: 'any' }),
          shopify.getProducts({ status: 'active', fields: 'id,title,variants,product_type' })
        ])

        // Co-occurrence: which products appear in the same order?
        const coOccurrence = {}
        const productTitles = {}
        const productPrices = {}
        const productSales = {}

        for (const order of orders) {
          if (order.financial_status === 'refunded' || order.cancelled_at) continue
          const items = (order.line_items || [])

          for (const item of items) {
            const pid = String(item.product_id)
            productTitles[pid] = item.title
            productPrices[pid] = parseFloat(item.price)
            productSales[pid] = (productSales[pid] || 0) + item.quantity
          }

          // Find pairs (only for multi-item orders)
          if (items.length >= 2) {
            for (let i = 0; i < items.length; i++) {
              for (let j = i + 1; j < items.length; j++) {
                const a = String(items[i].product_id)
                const b = String(items[j].product_id)
                const key = [a, b].sort().join(':')
                if (!coOccurrence[key]) coOccurrence[key] = { products: [a, b], count: 0 }
                coOccurrence[key].count++
              }
            }
          }
        }

        // Top pairs
        const topPairs = Object.values(coOccurrence)
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map(pair => ({
            productA: productTitles[pair.products[0]] || pair.products[0],
            productB: productTitles[pair.products[1]] || pair.products[1],
            priceA: productPrices[pair.products[0]],
            priceB: productPrices[pair.products[1]],
            timesBoughtTogether: pair.count,
            bundlePrice: ((productPrices[pair.products[0]] || 0) + (productPrices[pair.products[1]] || 0)) * 0.9
          }))

        // AOV analysis
        const orderValues = orders
          .filter(o => o.financial_status !== 'refunded' && !o.cancelled_at)
          .map(o => parseFloat(o.total_price || 0))
        const aov = orderValues.length > 0 ? orderValues.reduce((a, b) => a + b, 0) / orderValues.length : 0
        const multiItemOrders = orders.filter(o => (o.line_items || []).length > 1).length

        // Category affinity
        const categoryPairs = {}
        for (const order of orders) {
          if (order.financial_status === 'refunded') continue
          const cats = [...new Set((order.line_items || []).map(i => {
            const p = products.find(pp => pp.id === i.product_id)
            return p?.product_type || 'uncategorized'
          }))]
          for (let i = 0; i < cats.length; i++) {
            for (let j = i + 1; j < cats.length; j++) {
              const key = [cats[i], cats[j]].sort().join(' + ')
              categoryPairs[key] = (categoryPairs[key] || 0) + 1
            }
          }
        }

        const topCategoryPairs = Object.entries(categoryPairs)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([pair, count]) => ({ categories: pair, orders: count }))

        // Top single-item products (upsell targets)
        const singleItemProducts = {}
        for (const order of orders) {
          if ((order.line_items || []).length === 1 && !order.cancelled_at) {
            const pid = String(order.line_items[0].product_id)
            singleItemProducts[pid] = (singleItemProducts[pid] || 0) + 1
          }
        }

        const upsellTargets = Object.entries(singleItemProducts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([pid, count]) => ({
            productId: pid,
            title: productTitles[pid] || pid,
            price: productPrices[pid],
            singleItemOrders: count,
            opportunity: 'Frequently bought alone — cross-sell candidate'
          }))

        return {
          totalOrders: orders.length,
          aov: aov.toFixed(2),
          multiItemRate: orders.length > 0 ? ((multiItemOrders / orders.length) * 100).toFixed(1) + '%' : 'N/A',
          topPairs,
          topCategoryPairs,
          upsellTargets,
          totalProducts: products.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'present_upsell_report',
    description: 'Show the upsell/cross-sell opportunities report.',
    inputSchema: {
      type: 'object',
      properties: {
        currentAOV: { type: 'string' },
        targetAOV: { type: 'string' },
        bundles: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, products: { type: 'string' }, originalPrice: { type: 'string' }, bundlePrice: { type: 'string' }, expectedUplift: { type: 'string' } } } },
        crossSells: { type: 'array', items: { type: 'object', properties: { trigger: { type: 'string' }, recommend: { type: 'string' }, reason: { type: 'string' } } } },
        quickWins: { type: 'array', items: { type: 'string' } },
        estimatedRevenueLift: { type: 'string' },
        summary: { type: 'string' }
      },
      required: ['summary']
    },
    async execute(input) {
      logger.header('Upsell & Cross-Sell Report')

      if (input.currentAOV) logger.kv('Current AOV', '$' + input.currentAOV)
      if (input.targetAOV) logger.kv('Target AOV', '$' + input.targetAOV)
      if (input.estimatedRevenueLift) logger.kv('Est. Revenue Lift', input.estimatedRevenueLift)

      if (input.bundles?.length) {
        logger.blank()
        logger.bold('Bundle Recommendations')
        for (const b of input.bundles) {
          logger.item(`${b.name}`)
          logger.dim(`  Products: ${b.products}`)
          logger.dim(`  ${b.originalPrice} → ${b.bundlePrice} (${b.expectedUplift} uplift)`)
        }
      }

      if (input.crossSells?.length) {
        logger.blank()
        logger.bold('Cross-Sell Rules')
        for (const cs of input.crossSells) {
          logger.item(`When buying: ${cs.trigger}`)
          logger.dim(`  → Recommend: ${cs.recommend}`)
          logger.dim(`  Reason: ${cs.reason}`)
        }
      }

      if (input.quickWins?.length) {
        logger.blank()
        logger.bold('Quick Wins')
        for (const w of input.quickWins) logger.item(w)
      }

      logger.blank()
      logger.info(input.summary)

      await db.logAction({
        shop: config.getShop(),
        type: 'UPSELL',
        message: `Upsell analysis: ${input.bundles?.length || 0} bundles, ${input.crossSells?.length || 0} cross-sells`,
        metadata: { aov: input.currentAOV, bundles: input.bundles?.length, crossSells: input.crossSells?.length }
      })

      return { displayed: true }
    }
  }
]

async function run() {
  logger.header('Upsell & Cross-Sell')
  logger.spin('Analyzing purchase patterns...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Analyze all order data for upsell and cross-sell opportunities. Find frequently bought together products, create bundle recommendations, identify products that are always bought alone (cross-sell targets). Calculate potential revenue lift. Present a clear report.',
    tools,
    maxIterations: 8,
    onAction(name) {
      if (name === 'analyze_purchase_patterns') logger.spin('Mining purchase patterns...')
    }
  })

  logger.stopSpin(result.success ? 'Upsell analysis complete' : 'Upsell analysis failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
