// Shopify OAuth — Browser-based authorization for `dropship connect`
// Opens browser → merchant authorizes → localhost callback → token saved
// No new dependencies: uses Node builtins (http, crypto, child_process) + existing axios
import http from 'node:http'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import axios from 'axios'

const DEFAULT_PORT = 3456
const TIMEOUT_MS = 120_000 // 2 minutes
const SCOPES = [
  'read_products', 'write_products',
  'read_orders', 'write_orders',
  'read_fulfillments', 'write_fulfillments',
  'read_customers',
  'read_inventory',
  'read_analytics'
].join(',')

function openBrowser(url) {
  const platform = process.platform
  try {
    if (platform === 'darwin') execSync(`open "${url}"`)
    else if (platform === 'win32') execSync(`start "" "${url}"`)
    else execSync(`xdg-open "${url}"`)
  } catch {
    // Browser open failed — user will see the URL printed in terminal
  }
}

function successHTML(shop) {
  return `<!DOCTYPE html><html><head><title>Connected!</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.box{text-align:center;padding:2rem}.check{font-size:3rem;margin-bottom:1rem}h1{margin:0 0 .5rem}p{color:#888}</style></head>
<body><div class="box"><div class="check">&#10003;</div><h1>Connected to ${shop}</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`
}

function errorHTML(msg) {
  return `<!DOCTYPE html><html><head><title>Error</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fff}
.box{text-align:center;padding:2rem}h1{color:#f44;margin:0 0 .5rem}p{color:#888}</style></head>
<body><div class="box"><h1>Connection Failed</h1><p>${msg}</p><p>Return to the terminal and try again.</p></div></body></html>`
}

/**
 * Start Shopify OAuth flow
 * @param {string} shop - e.g. "my-store.myshopify.com"
 * @param {{ apiKey: string, apiSecret: string }} creds
 * @returns {Promise<{ shop: string, accessToken: string }>}
 */
async function startOAuthFlow(shop, { apiKey, apiSecret }) {
  const state = crypto.randomBytes(24).toString('hex')
  const redirectUri = `http://127.0.0.1:${DEFAULT_PORT}/callback`
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${apiKey}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${DEFAULT_PORT}`)

      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const returnedShop = url.searchParams.get('shop')

      // CSRF check
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHTML('State mismatch — possible CSRF attack.'))
        cleanup(server, timer)
        reject(new Error('OAuth state mismatch'))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHTML('No authorization code received.'))
        cleanup(server, timer)
        reject(new Error('No authorization code'))
        return
      }

      // Exchange code for access token
      try {
        const tokenRes = await axios.post(
          `https://${returnedShop || shop}/admin/oauth/access_token`,
          { client_id: apiKey, client_secret: apiSecret, code },
          { timeout: 15000 }
        )
        const accessToken = tokenRes.data.access_token
        if (!accessToken) throw new Error('No access_token in response')

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(successHTML(returnedShop || shop))
        cleanup(server, timer)
        resolve({ shop: returnedShop || shop, accessToken })
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(errorHTML(err.message))
        cleanup(server, timer)
        reject(new Error(`Token exchange failed: ${err.message}`))
      }
    })

    const timer = setTimeout(() => {
      cleanup(server, timer)
      reject(new Error('OAuth timed out — no response within 2 minutes'))
    }, TIMEOUT_MS)

    server.on('error', (err) => {
      clearTimeout(timer)
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${DEFAULT_PORT} is in use. Close the other process and try again.`))
      } else {
        reject(err)
      }
    })

    server.listen(DEFAULT_PORT, '127.0.0.1', () => {
      openBrowser(authUrl)
    })
  })
}

function cleanup(server, timer) {
  clearTimeout(timer)
  try { server.close() } catch {}
}

export { startOAuthFlow, SCOPES, DEFAULT_PORT }
export default { startOAuthFlow, SCOPES, DEFAULT_PORT }
