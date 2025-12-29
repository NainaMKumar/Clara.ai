export type ChunkSpec = {
  maxChars: number
  overlapChars: number
}

export const DEFAULT_CHUNK_SPEC: ChunkSpec = {
  maxChars: 2000,
  overlapChars: 250,
}

export function stripHtmlToText(html: string): string {
  // Notes are stored as HTML (TipTap). Convert to readable plain text for embeddings.
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent || div.innerText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function chunkText(text: string, spec: ChunkSpec = DEFAULT_CHUNK_SPEC): string[] {
  const cleaned = text.trim()
  if (!cleaned) return []

  const chunks: string[] = []
  const { maxChars, overlapChars } = spec

  let start = 0
  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + maxChars)
    const slice = cleaned.slice(start, end).trim()
    if (slice) chunks.push(slice)
    if (end >= cleaned.length) break
    start = Math.max(0, end - overlapChars)
    if (start === end) break
  }

  return chunks
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const arr = Array.from(new Uint8Array(digest))
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('')
}


