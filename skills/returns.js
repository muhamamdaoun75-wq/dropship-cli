// Returns Skill — Handle returns, refunds, and defect analysis
// AI agent that processes return requests and protects margins
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Returns Agent — you handle returns and refunds while protecting margins.

Your job: Process return requests intelligently, issue refunds when warranted, and track defect patterns.

## Process
1. Get orders with refund/return signals (cancelled, partially refunded, customer complaints)
2. For each return:
   - Check if refund is warranted (defective, wrong item, not as described)
   - Calculate refund amount (full, partial, or store credit recommendation)
   - Flag repeat returners and potential abuse
3. Analyze return patterns by product and supplier
4. Present a report with actions taken and recommendations

## Rules
- Refunds under $25: auto-approve (cost of processing > cost of refund)
- Refunds $25-100: approve if legitimate, flag if pattern
- Refunds over $100: flag for manual review
- Track return rate per product — if >15%, flag as defective
- Track return rate per customer — if >3 returns, flag as potential abuse
- Always recommend root cause fix (better photos, sizing chart, description update)

Be fair to customers but protect the business.`

const tools = [
  {
    name: 'get_return_candidates',
    description: 'Get orders that may need returns/refunds processing.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const allOrders = await shopify.getOrders({ limit: '100', status: 'any' })

        const returnCandidates = []

        for (const order of allOrders) {
          const isRefunded = order.financial_status === 'refunded' || order.financial_status === 'partially_refunded'
          const isCancelled = !!order.cancelled_at
          const hasNote = order.note && (
            order.note.toLowerCase().includes('return') ||
            order.note.toLowerCase().includes('refund') ||
            order.note.toLowerCase().includes('wrong') ||
            order.note.toLowerCase().includes('defect')
          )

          if (isRefunded || isCancelled || hasNote) {
            returnCandidates.push({
              id: order.id,
              number: order.order_number,
              email: order.email,
              total: order.total_price,
              status: order.financial_status,
              cancelled: isCancelled,
              createdAt: order.created_at,
              note: order.note || null,
              items: (order.line_items || []).map(li => ({
                title: li.title,
                quantity: li.quantity,
                price: li.price,
                productId: li.product_id
              }))
            })
          }
        }

        // Track return rate per product
        const productReturns = {}
        const productOrders = {}
        for (const order of allOrders) {
          for (const item of (order.line_items || [])) {
            const pid = String(item.product_id)
            productOrders[pid] = (productOrders[pid] || 0) + 1
          }
        }
        for (const ret of returnCandidates) {
          for (const item of ret.items) {
            const pid = String(item.productId)
            productReturns[pid] = (productReturns[pid] || 0) + 1
          }
        }

        const problemProducts = Object.entries(productReturns)
          .map(([pid, returns]) => ({
            productId: pid,
            returns,
            totalOrders: productOrders[pid] || 0,
            returnRate: productOrders[pid] ? ((returns / productOrders[pid]) * 100).toFixed(1) + '%' : 'N/A'
          }))
          .filter(p => p.returns >= 2)
          .sort((a, b) => b.returns - a.returns)

        return {
          totalReturns: returnCandidates.length,
          candidates: returnCandidates.slice(0, 20),
          problemProducts: problemProducts.slice(0, 10),
          totalOrdersChecked: allOrders.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'process_refund',
    description: 'Issue a refund for an order. Use for orders that warrant a refund.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number' },
        orderNumber: { type: 'number' },
        amount: { type: 'number', description: 'Refund amount (0 for full refund)' },
        reason: { type: 'string' },
        note: { type: 'string', description: 'Internal note about this refund' }
      },
      required: ['orderId', 'reason']
    },
    async execute(input) {
      try {
        // Note: Shopify refund API requires specific fulfillment/transaction data
        // For now, log the refund decision and flag for manual processing
        logger.info(`Refund recommended: Order #${input.orderNumber || input.orderId}`)
        logger.dim(`  Amount: ${input.amount ? '$' + input.amount : 'Full refund'}`)
        logger.dim(`  Reason: ${input.reason}`)

        await db.logAction({
          shop: config.getShop(),
          type: 'REFUND_RECOMMENDED',
          message: `Refund for #${input.orderNumber || input.orderId}: ${input.reason}`,
          metadata: { orderId: input.orderId, amount: input.amount, reason: input.reason }
        })

        return { logged: true, orderId: input.orderId, note: 'Refund recommendation logged — process in Shopify admin' }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'flag_abuse',
    description: 'Flag a customer for potential return abuse.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        reason: { type: 'string' },
        returnCount: { type: 'number' }
      },
      required: ['email', 'reason']
    },
    async execute(input) {
      logger.warn(`Potential abuse: ${input.email} — ${input.reason}`)

      await db.logAction({
        shop: config.getShop(),
        type: 'ABUSE_FLAG',
        message: `Flagged ${input.email}: ${input.reason}`,
        metadata: { email: input.email, returnCount: input.returnCount }
      })

      return { flagged: true }
    }
  },
  {
    name: 'present_returns_report',
    description: 'Show the returns analysis report.',
    inputSchema: {
      type: 'object',
      properties: {
        totalProcessed: { type: 'number' },
        refundsRecommended: { type: 'number' },
        totalRefundValue: { type: 'number' },
        abuseFlags: { type: 'number' },
        problemProducts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, returnRate: { type: 'string' }, action: { type: 'string' } } } },
        recommendations: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      },
      required: ['summary']
    },
    async execute(input) {
      logger.header('Returns Report')
      if (input.totalProcessed !== undefined) logger.kv('Processed', input.totalProcessed)
      if (input.refundsRecommended) logger.kv('Refunds Recommended', input.refundsRecommended)
      if (input.totalRefundValue) logger.kv('Total Refund Value', logger.money(input.totalRefundValue))
      if (input.abuseFlags) logger.kv('Abuse Flags', input.abuseFlags)

      if (input.problemProducts?.length) {
        logger.blank()
        logger.bold('Problem Products')
        for (const p of input.problemProducts) {
          logger.item(`${p.title} — ${p.returnRate} return rate`)
          if (p.action) logger.dim(`  → ${p.action}`)
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
  logger.header('Returns & Refunds')
  logger.spin('Scanning returns...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Analyze all return candidates. Process refunds for clear-cut cases. Flag abuse patterns. Identify problem products with high return rates. Present a returns report with recommendations.',
    tools,
    maxIterations: 10,
    onAction(name) {
      if (name === 'get_return_candidates') logger.spin('Finding return candidates...')
      if (name === 'process_refund') logger.spin('Processing refund...')
      if (name === 'flag_abuse') logger.spin('Checking abuse patterns...')
    }
  })

  logger.stopSpin(result.success ? 'Returns analysis complete' : 'Returns analysis failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
