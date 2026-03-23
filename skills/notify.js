// Notify Skill — Setup and test notification webhooks
// Manages Slack/Discord alerts for critical business events
import logger from '../lib/logger.js'
import config from '../lib/config.js'
import { sendAlert, formatAlert } from '../lib/notify.js'
import inquirer from 'inquirer'

async function run(opts = {}) {
  logger.header('Notifications')

  if (opts.setup) {
    await setup()
    return
  }

  if (opts.test) {
    await testWebhooks()
    return
  }

  // Show current status
  const webhooks = config.getWebhooks()
  const hasSlack = !!webhooks.slack
  const hasDiscord = !!webhooks.discord

  if (!hasSlack && !hasDiscord) {
    logger.warn('No notification channels configured.')
    logger.blank()
    logger.info('Setup notifications:')
    logger.dim('  dropship notify --setup')
    logger.blank()
    logger.info('Supported channels:')
    logger.item('Slack (webhook URL)')
    logger.item('Discord (webhook URL)')
    return
  }

  logger.kv('Slack', hasSlack ? '✓ Connected' : '✗ Not configured')
  logger.kv('Discord', hasDiscord ? '✓ Connected' : '✗ Not configured')
  logger.blank()
  logger.info('Test: dropship notify --test')
  logger.info('Reconfigure: dropship notify --setup')
}

async function setup() {
  logger.info('Configure notification webhooks:')
  logger.blank()

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'slack',
      message: 'Slack webhook URL (leave blank to skip):',
      default: config.getWebhook('slack') || '',
      validate: v => !v || v.startsWith('https://hooks.slack.com/') || 'Must be a Slack webhook URL'
    },
    {
      type: 'input',
      name: 'discord',
      message: 'Discord webhook URL (leave blank to skip):',
      default: config.getWebhook('discord') || '',
      validate: v => !v || v.startsWith('https://discord.com/api/webhooks/') || 'Must be a Discord webhook URL'
    }
  ])

  if (answers.slack) {
    config.setWebhook('slack', answers.slack)
    logger.success('Slack webhook saved')
  } else {
    config.removeWebhook('slack')
  }

  if (answers.discord) {
    config.setWebhook('discord', answers.discord)
    logger.success('Discord webhook saved')
  } else {
    config.removeWebhook('discord')
  }

  logger.blank()

  if (answers.slack || answers.discord) {
    logger.spin('Sending test notification...')
    const msg = formatAlert('success', { message: 'Dropship CLI notifications are working!' })
    const results = await sendAlert(msg)
    logger.stopSpin('Done')

    for (const r of results) {
      if (r.sent) {
        logger.success(`${r.channel}: Test message sent`)
      } else {
        logger.error(`${r.channel}: ${r.error}`)
      }
    }
  }
}

async function testWebhooks() {
  logger.spin('Sending test notification...')

  const msg = formatAlert('info', {
    message: 'This is a test notification from Dropship CLI',
    details: `Store: ${config.getShop() || 'not connected'}`
  })

  const results = await sendAlert(msg)
  logger.stopSpin('Done')

  for (const r of results) {
    if (r.sent) {
      logger.success(`${r.channel}: Delivered`)
    } else {
      logger.error(`${r.channel}: ${r.error}`)
    }
  }
}

export default { run, setup, testWebhooks }
