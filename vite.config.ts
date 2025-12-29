import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Ensure server-side handlers (api/*) can read non-VITE env vars (e.g. OPENAI_API_KEY)
  // during local dev/preview.
  const loaded = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(loaded)) {
    if (v !== undefined) process.env[k] = v
  }

  return {
    plugins: [
      react(),
      {
        name: 'clara-rag-api-dev',
        configureServer(server) {
          const handler = createApiMiddleware()
          server.middlewares.use(handler)
        },
        configurePreviewServer(server) {
          const handler = createApiMiddleware()
          server.middlewares.use(handler)
        },
      },
    ],
  }
})

function createApiMiddleware() {
  // Lazy import so production builds don't eagerly pull these into the client bundle.
  return async function apiMiddleware(req: any, res: any, next: any) {
    const url = String(req.url || '')
    if (!url.startsWith('/api/')) return next()

    // Only handle the API endpoints here.
    const pathname = url.split('?')[0]
    if (
      pathname !== '/api/embed' &&
      pathname !== '/api/chat' &&
      pathname !== '/api/note_feedback' &&
      pathname !== '/api/note_feedback_fix'
    )
      return next()

    // Parse JSON body (Vite dev server does not do this for us).
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        req.body = body
      } catch (e) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Invalid JSON' }))
        return
      }
    }

    try {
      if (pathname === '/api/embed') {
        const mod = await import('./api/embed')
        return await mod.default(req, res)
      }
      if (pathname === '/api/chat') {
        const mod = await import('./api/chat')
        return await mod.default(req, res)
      }
      if (pathname === '/api/note_feedback') {
        const mod = await import('./api/note_feedback')
        return await mod.default(req, res)
      }
      if (pathname === '/api/note_feedback_fix') {
        const mod = await import('./api/note_feedback_fix')
        return await mod.default(req, res)
      }
      return next()
    } catch (e) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Server error' }))
      return
    }
  }
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: any) => {
      data += chunk
      // Basic guardrail
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'))
        try {
          req.destroy()
        } catch {
          // ignore
        }
      }
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', () => reject(new Error('Failed to read request body')))
  })
}
