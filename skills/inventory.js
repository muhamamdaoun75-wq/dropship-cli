// Inventory Skill — Sync inventory, detect stockouts, manage dead stock
// AI agent that keeps inventory healthy and prevents overselling
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Inventory Agent — you prevent stockouts and eliminate dead stock.

Your job: Keep inventory levels healthy, sync with suppliers, and optimize the catalog.

## Process
1. Pull all inventory levels from Shopify
2. Cross-check with supplier stock (if CJ connected)
3. Identify:
   - OUT OF STOCK: Active products with 0 inventory (losing sales NOW)
   - LOW STOCK: Products with <5 units (will stockout soon)
   - DEAD STOCK: Products with high inventory but zero sales in 30+ days
   - OVERSOLD: Products sold but with negative inventory
4. Calculate inventory turnover rate
5. Recommend reorder quantities and dead stock actions

## Rules
- Out of stock + still active = CRITICAL (deactivate or reorder immediately)
- Low stock on a bestseller = URGENT (reorder now)
- Dead stock > 30 days = recommend clearance pricing or removal
- Always calculate days of supply: current_stock / avg_daily_sales
- Flag products with no supplier mapping (can't reorder)

Be precise with numbers. Inventory errors cost real money.`

const tools = [
  {
    name: 'get_inventory_levels',
    description: 'Get current inventory levels for all products.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const products = await shopify.getProducts({ status: 'active', fields: 'id,title,variants,status,product_type' })
        const inventory = []

        for (const p of products) {
          for (const v of (p.variants || [])) {
            const qty = v.inventory_quantity ?? 0
            const mapping = config.getProductMapping(String(p.id))
            inventory.push({
              productId: p.id,
              variantId: v.id,
              title: p.title,
              variantTitle: v.title === 'Default Title' ? null : v.title,
              sku: v.sku,
              quantity: qty,
              price: parseFloat(v.price || 0),
              type: p.product_type,
              tracked: v.inventory_management === 'shopify',
              hasSupplierMapping: !!mapping,
              supplierName: mapping ? 'CJ' : null
            })
          }
        }

        const outOfStock = inventory.filter(i => i.tracked && i.quantity <= 0)
        const lowStock = inventory.filter(i => i.tracked && i.quantity > 0 && i.quantity <= 5)
        const oversold = inventory.filter(i => i.tracked && i.quantity < 0)
        const healthy = inventory.filter(i => !i.tracked || i.quantity > 5)

        return {
          totalProducts: products.length,
          totalVariants: inventory.length,
          tracked: inventory.filter(i => i.tracked).length,
          outOfStock: outOfStock.map(i => ({ ...i, status: 'OUT_OF_STOCK' })),
          lowStock: lowStock.map(i => ({ ...i, status: 'LOW_STOCK' })),
          oversold: oversold.map(i => ({ ...i, status: 'OVERSOLD' })),
          healthyCount: healthy.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'check_supplier_stock',
    description: 'Check if supplier has stock for a product. Requires CJ connection.',
    inputSchema: {
      type: 'object',
      properties: {
        productTitle: { type: 'string', description: 'Product title to search' },
        shopifyProductId: { type: 'string' }
      },
      required: ['productTitle']
    },
    async execute(input) {
      try {
        const cj = await import('../lib/cj.js')
        const results = await cj.searchProducts(input.productTitle, { pageSize: 3 })
        if (results.length === 0) return { available: false, message: 'Not found in supplier catalog' }

        return {
          available: true,
          supplierProducts: results.map(p => ({
            title: p.title,
            price: p.price,
            supplier: 'CJ',
            id: p.id
          }))
        }
      } catch (err) {
        return { available: false, error: err.message }
      }
    }
  },
  {
    name: 'get_sales_velocity',
    description: 'Get sales velocity data to calculate days of supply.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const orders = await shopify.getOrders({ created_at_min: since, limit: '250', status: 'any' })

        const productSales = {}
        for (const order of orders) {
          if (order.financial_status === 'refunded' || order.cancelled_at) continue
          for (const item of (order.line_items || [])) {
            const pid = String(item.product_id)
            if (!productSales[pid]) productSales[pid] = { title: item.title, units: 0, revenue: 0 }
            productSales[pid].units += item.quantity
            productSales[pid].revenue += parseFloat(item.price) * item.quantity
          }
        }

        // Calculate daily velocity
        const velocity = Object.entries(productSales).map(([pid, data]) => ({
          productId: pid,
          title: data.title,
          unitsSold30d: data.units,
          revenue30d: data.revenue.toFixed(2),
          dailyVelocity: (data.units / 30).toFixed(2)
        })).sort((a, b) => b.unitsSold30d - a.unitsSold30d)

        // Products with zero sales in 30 days
        const products = await shopify.getProducts({ status: 'active', fields: 'id,title' })
        const soldIds = new Set(Object.keys(productSales))
        const deadStock = products.filter(p => !soldIds.has(String(p.id))).map(p => ({
          productId: String(p.id),
          title: p.title,
          unitsSold30d: 0,
          dailyVelocity: '0'
        }))

        return {
          period: '30d',
          totalOrdersAnalyzed: orders.length,
          topSellers: velocity.slice(0, 15),
          deadStock: deadStock.slice(0, 15),
          deadStockCount: deadStock.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'present_inventory_report',
    description: 'Show the inventory health report.',
    inputSchema: {
      type: 'object',
      properties: {
        outOfStockCount: { type: 'number' },
        lowStockCount: { type: 'number' },
        deadStockCount: { type: 'number' },
        oversoldCount: { type: 'number' },
        healthScore: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
        reorderNeeded: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, currentStock: { type: 'number' }, daysOfSupply: { type: 'string' }, action: { type: 'string' } } } },
        deadStockActions: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, action: { type: 'string' } } } },
        summary: { type: 'string' }
      },
      required: ['healthScore', 'summary']
    },
    async execute(input) {
      logger.header('Inventory Health Report')

      const gradeColor = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', F: '🔴' }
      logger.bold(`Health Score: ${gradeColor[input.healthScore] || ''} ${input.healthScore}`)
      logger.blank()

      if (input.outOfStockCount !== undefined) logger.kv('Out of Stock', input.outOfStockCount)
      if (input.lowStockCount !== undefined) logger.kv('Low Stock', input.lowStockCount)
      if (input.deadStockCount !== undefined) logger.kv('Dead Stock', input.deadStockCount)
      if (input.oversoldCount) logger.kv('Oversold', input.oversoldCount)

      if (input.reorderNeeded?.length) {
        logger.blank()
        logger.bold('Reorder Needed')
        for (const r of input.reorderNeeded) {
          logger.item(`${r.title} — ${r.currentStock} left (${r.daysOfSupply} days supply)`)
          if (r.action) logger.dim(`  → ${r.action}`)
        }
      }

      if (input.deadStockActions?.length) {
        logger.blank()
        logger.bold('Dead Stock Actions')
        for (const d of input.deadStockActions) {
          logger.item(`${d.title}`)
          logger.dim(`  → ${d.action}`)
        }
      }

      logger.blank()
      logger.info(input.summary)

      await db.logAction({
        shop: config.getShop(),
        type: 'INVENTORY',
        message: `Inventory health: ${input.healthScore}`,
        metadata: { grade: input.healthScore, oos: input.outOfStockCount, low: input.lowStockCount }
      })

      return { displayed: true }
    }
  }
]

async function run() {
  logger.header('Inventory Management')
  logger.spin('Checking inventory...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Run a full inventory health check. Get current levels, calculate sales velocity, identify stockouts and dead stock. Present a clear report with health score and action items.',
    tools,
    maxIterations: 10,
    onAction(name) {
      if (name === 'get_inventory_levels') logger.spin('Loading inventory...')
      if (name === 'check_supplier_stock') logger.spin('Checking supplier stock...')
      if (name === 'get_sales_velocity') logger.spin('Calculating sales velocity...')
    }
  })

  logger.stopSpin(result.success ? 'Inventory check complete' : 'Inventory check failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
