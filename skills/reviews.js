// Reviews Skill — Review analysis, response drafting, reputation management
// AI agent that monitors and manages product reviews and store reputation
import { runAgent } from '../lib/ai.js'
import config from '../lib/config.js'
import logger from '../lib/logger.js'
import * as shopify from '../lib/shopify.js'
import * as db from '../lib/db.js'

const SYSTEM = `You are the Reviews Agent — you protect and build store reputation.

Your job: Analyze product reviews, draft responses, flag reputation risks, and recommend improvements.

## Process
1. Pull recent orders and customer feedback signals
2. Analyze sentiment patterns per product
3. Draft professional responses to negative feedback
4. Identify products with reputation risk (high refund rate, complaints)
5. Calculate a store reputation score
6. Recommend specific actions to improve ratings

## Response Guidelines
- Negative reviews: Empathetic, solution-focused, offer to make it right
- Positive reviews: Thank them, reinforce their choice, encourage sharing
- Neutral reviews: Acknowledge feedback, ask how to improve

## Reputation Risk Signals
- High refund rate on a product (>10%)
- Multiple cancellations
- Repeat customer complaints about same issue
- Products with no reviews (social proof gap)

Be the voice of a brand that genuinely cares about customers.`

const tools = [
  {
    name: 'get_reputation_data',
    description: 'Get order and customer data to assess store reputation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const [orders, customers, products] = await Promise.all([
          shopify.getOrders({ limit: '100', status: 'any' }),
          shopify.getCustomers({ limit: '50' }),
          shopify.getProducts({ status: 'active', fields: 'id,title,product_type' })
        ])

        // Refund analysis per product
        const productStats = {}
        for (const order of orders) {
          const isRefunded = order.financial_status === 'refunded' || order.financial_status === 'partially_refunded'
          const isCancelled = !!order.cancelled_at

          for (const item of (order.line_items || [])) {
            const pid = String(item.product_id)
            if (!productStats[pid]) productStats[pid] = { title: item.title, orders: 0, refunds: 0, cancels: 0, revenue: 0 }
            productStats[pid].orders++
            productStats[pid].revenue += parseFloat(item.price) * item.quantity
            if (isRefunded) productStats[pid].refunds++
            if (isCancelled) productStats[pid].cancels++
          }
        }

        // Customer satisfaction signals
        const repeatCustomers = customers.filter(c => c.orders_count > 1).length
        const avgOrderCount = customers.length > 0
          ? (customers.reduce((s, c) => s + (c.orders_count || 0), 0) / customers.length).toFixed(1)
          : 0

        // Products with reputation issues
        const riskProducts = Object.entries(productStats)
          .map(([pid, stats]) => ({
            productId: pid,
            ...stats,
            refundRate: stats.orders > 0 ? ((stats.refunds / stats.orders) * 100).toFixed(1) + '%' : '0%',
            refundRateNum: stats.orders > 0 ? (stats.refunds / stats.orders) * 100 : 0
          }))
          .filter(p => p.refundRateNum > 10 || p.cancels > 2)
          .sort((a, b) => b.refundRateNum - a.refundRateNum)

        // Notes/comments from orders (customer feedback)
        const orderNotes = orders
          .filter(o => o.note && o.note.length > 5)
          .map(o => ({
            orderNumber: o.order_number,
            email: o.email,
            note: o.note,
            total: o.total_price,
            date: o.created_at
          }))
          .slice(0, 20)

        // Calculate reputation score
        const totalOrders = orders.length
        const totalRefunds = orders.filter(o => o.financial_status === 'refunded' || o.financial_status === 'partially_refunded').length
        const refundRate = totalOrders > 0 ? (totalRefunds / totalOrders * 100) : 0
        let reputationScore = 100
        reputationScore -= refundRate * 3  // -3 per percent refund rate
        reputationScore -= riskProducts.length * 5  // -5 per risk product
        if (repeatCustomers / (customers.length || 1) > 0.2) reputationScore += 10  // bonus for repeat buyers
        reputationScore = Math.max(0, Math.min(100, Math.round(reputationScore)))

        return {
          totalOrders,
          totalCustomers: customers.length,
          repeatCustomers,
          avgOrderCount,
          refundRate: refundRate.toFixed(1) + '%',
          reputationScore,
          riskProducts: riskProducts.slice(0, 10),
          customerFeedback: orderNotes,
          totalProducts: products.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },
  {
    name: 'draft_response',
    description: 'Draft a response to customer feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        customerEmail: { type: 'string' },
        orderNumber: { type: 'number' },
        feedback: { type: 'string' },
        sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
        response: { type: 'string', description: 'The drafted response' },
        action: { type: 'string', description: 'Recommended action (refund, replace, follow-up, none)' }
      },
      required: ['feedback', 'sentiment', 'response']
    },
    async execute(input) {
      const icon = input.sentiment === 'positive' ? '🟢' : input.sentiment === 'negative' ? '🔴' : '🟡'
      logger.info(`${icon} [${input.sentiment.toUpperCase()}] Order #${input.orderNumber || 'N/A'}`)
      logger.dim(`  Feedback: ${input.feedback.slice(0, 100)}`)
      logger.dim(`  Response: ${input.response.slice(0, 150)}...`)
      if (input.action && input.action !== 'none') logger.dim(`  Action: ${input.action}`)

      await db.logAction({
        shop: config.getShop(),
        type: 'REVIEW_RESPONSE',
        message: `Drafted ${input.sentiment} response for order #${input.orderNumber || 'N/A'}`,
        metadata: { sentiment: input.sentiment, action: input.action }
      })

      return { drafted: true }
    }
  },
  {
    name: 'present_reputation_report',
    description: 'Show the reputation and reviews report.',
    inputSchema: {
      type: 'object',
      properties: {
        reputationScore: { type: 'number' },
        grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
        riskProducts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, issue: { type: 'string' }, action: { type: 'string' } } } },
        responsesNeeded: { type: 'number' },
        recommendations: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      },
      required: ['reputationScore', 'grade', 'summary']
    },
    async execute(input) {
      logger.header('Reputation Report')

      const gradeColor = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', F: '🔴' }
      logger.bold(`Reputation Score: ${input.reputationScore}/100 ${gradeColor[input.grade] || ''} ${input.grade}`)
      logger.blank()

      if (input.responsesNeeded) logger.kv('Responses Needed', input.responsesNeeded)

      if (input.riskProducts?.length) {
        logger.blank()
        logger.bold('Reputation Risk Products')
        for (const p of input.riskProducts) {
          logger.item(`${p.title} — ${p.issue}`)
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

      await db.logAction({
        shop: config.getShop(),
        type: 'REVIEWS',
        message: `Reputation: ${input.reputationScore}/100 (${input.grade})`,
        metadata: { score: input.reputationScore, grade: input.grade }
      })

      return { displayed: true }
    }
  }
]

async function run() {
  logger.header('Reviews & Reputation')
  logger.spin('Analyzing reputation...')

  const result = await runAgent({
    system: SYSTEM,
    task: 'Analyze store reputation. Pull order data, identify products with high refund/complaint rates, draft responses to customer feedback, calculate reputation score. Present a clear report with grade and action items.',
    tools,
    maxIterations: 10,
    onAction(name) {
      if (name === 'get_reputation_data') logger.spin('Loading reputation data...')
      if (name === 'draft_response') logger.spin('Drafting responses...')
    }
  })

  logger.stopSpin(result.success ? 'Reputation analysis complete' : 'Reputation analysis failed', result.success)
  if (!result.success) logger.error(result.result)

  logger.blank()
  logger.dim(`Completed in ${(result.duration / 1000).toFixed(1)}s (${result.iterations} iterations)`)
}

export default { run }
