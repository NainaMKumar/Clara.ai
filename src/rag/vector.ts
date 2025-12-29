export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function l2Norm(a: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s)
}

export function normalize(a: number[]): number[] {
  const n = l2Norm(a)
  if (!Number.isFinite(n) || n <= 0) return a.slice()
  return a.map((x) => x / n)
}

export function cosineSimilarityNormalized(normA: number[], normB: number[]): number {
  // If vectors are unit-normalized, cosine similarity is just dot product.
  return dot(normA, normB)
}


