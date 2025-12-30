import type {
  NoteConnectionsRequest,
  NoteConnectionsResponse,
  NoteConnection,
  ConnectionQuote,
} from './_types';
import { env } from './env';

type ChunkInfo = {
  chunkId: string;
  noteId: string;
  noteTitle: string;
  text: string;
};

function requiredEnv(name: string): string {
  const val =
    env[name] ??
    (name === 'OPENAI_API_KEY' ? env.VITE_OPENAI_API_KEY : undefined);
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function getAllowedOrigins(): string[] {
  const raw = env.RAG_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyCors(req: any, res: any): boolean {
  const allowed = getAllowedOrigins();
  const origin = String(req.headers?.origin ?? '');
  if (allowed.length === 0) {
    return true;
  }
  if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    return true;
  }
  if (origin) return false;
  return true;
}

function sendJson(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clampText(input: unknown, maxChars: number): string {
  return String(input ?? '').slice(0, maxChars);
}

function toConnectionsShape(
  input: unknown,
  chunksByNote: Map<string, ChunkInfo[]>
): NoteConnection[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const connectionsRaw = Array.isArray(obj.connections) ? obj.connections : [];

  const validNoteIds = new Set(chunksByNote.keys());
  const noteIdToTitle = new Map<string, string>();
  for (const [noteId, chunks] of chunksByNote) {
    if (chunks.length > 0) {
      noteIdToTitle.set(noteId, chunks[0].noteTitle);
    }
  }

  const connections: NoteConnection[] = [];

  for (const c of connectionsRaw) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;

    const typeRaw = String(rec.type ?? '');
    if (!['thematic', 'contradiction', 'extension', 'gap'].includes(typeRaw)) {
      continue;
    }
    const type = typeRaw as NoteConnection['type'];

    const noteIdsRaw = Array.isArray(rec.noteIds) ? rec.noteIds : [];
    const noteIds = noteIdsRaw
      .map((id) => String(id ?? '').trim())
      .filter((id) => validNoteIds.has(id));

    if (noteIds.length < 1) continue;

    const noteTitles = noteIds.map((id) => noteIdToTitle.get(id) ?? 'Untitled');

    const description = String(rec.description ?? '').trim();
    const insight = String(rec.insight ?? '').trim();

    if (!description || !insight) continue;

    const quotesRaw = Array.isArray(rec.quotes) ? rec.quotes : [];
    const quotes: ConnectionQuote[] = quotesRaw
      .map((q) => {
        if (!q || typeof q !== 'object') return null;
        const qq = q as Record<string, unknown>;
        const noteId = String(qq.noteId ?? '').trim();
        const text = String(qq.text ?? '').trim();
        if (!noteId || !text || !validNoteIds.has(noteId)) return null;
        return {
          noteId,
          noteTitle: noteIdToTitle.get(noteId) ?? 'Untitled',
          text: text.slice(0, 300),
        };
      })
      .filter((x): x is ConnectionQuote => x !== null)
      .slice(0, 4);

    connections.push({
      type,
      noteIds,
      noteTitles,
      description: description.slice(0, 500),
      quotes,
      insight: insight.slice(0, 500),
    });
  }

  return connections.slice(0, 12);
}

export default async function handler(req: any, res: any) {
  if (!applyCors(req, res)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = (req.body || {}) as NoteConnectionsRequest & {
      chunks?: ChunkInfo[];
    };

    // The client sends chunks directly since IndexedDB is client-side
    const chunks: ChunkInfo[] = Array.isArray(body.chunks)
      ? body.chunks.map((c) => ({
          chunkId: String(c.chunkId ?? ''),
          noteId: String(c.noteId ?? ''),
          noteTitle: clampText(c.noteTitle, 200),
          text: clampText(c.text, 2000),
        }))
      : [];

    if (chunks.length === 0) {
      return sendJson(res, 400, { error: 'No chunks provided for analysis' });
    }

    const focusNoteId = body.focusNoteId
      ? String(body.focusNoteId).trim()
      : undefined;
    const maxConnections = Math.min(
      12,
      Math.max(1, Number(body.maxConnections) || 8)
    );

    // Group chunks by note
    const chunksByNote = new Map<string, ChunkInfo[]>();
    for (const c of chunks) {
      if (!c.noteId || !c.text) continue;
      const arr = chunksByNote.get(c.noteId) ?? [];
      arr.push(c);
      chunksByNote.set(c.noteId, arr);
    }

    const noteIds = Array.from(chunksByNote.keys());
    if (noteIds.length < 2) {
      // Need at least 2 notes to find connections
      const out: NoteConnectionsResponse = {
        connections: [],
        analyzedNoteIds: noteIds,
        provider: 'openai',
        model: env.OPENAI_CHAT_MODEL || 'gpt-5.2',
      };
      return sendJson(res, 200, out);
    }

    const apiKey = requiredEnv('OPENAI_API_KEY');
    const model = env.OPENAI_CHAT_MODEL || 'gpt-5.2';

    // Build context block with all notes
    const notesBlock = Array.from(chunksByNote.entries())
      .map(([noteId, noteChunks]) => {
        const title = noteChunks[0]?.noteTitle ?? 'Untitled';
        const content = noteChunks.map((c) => c.text).join('\n\n');
        return [
          `NOTE_ID: ${noteId}`,
          `TITLE: ${title}`,
          `CONTENT:`,
          content.slice(0, 3000),
        ].join('\n');
      })
      .join('\n\n---\n\n');

    const focusInstruction = focusNoteId
      ? `Focus especially on connections involving the note with ID: ${focusNoteId}`
      : '';

    const system = [
      'You are a critical thinking assistant that finds meaningful connections between notes.',
      'Analyze the provided notes and identify connections, patterns, contradictions, and insights.',
      '',
      'Look for:',
      '1. THEMATIC connections: Similar topics discussed from different angles or contexts',
      '2. CONTRADICTIONS: Conflicting information or viewpoints between notes',
      "3. EXTENSIONS: How one note's ideas build upon or support another",
      '4. GAPS: Questions or missing pieces that arise from combining the knowledge',
      '',
      'Return ONLY valid JSON with this exact shape:',
      '{',
      '  "connections": Array<{',
      '    "type": "thematic" | "contradiction" | "extension" | "gap",',
      '    "noteIds": string[],  // IDs of notes involved (2+ notes)',
      '    "description": string,  // What the connection is',
      '    "quotes": Array<{ "noteId": string, "text": string }>,  // Supporting quotes',
      '    "insight": string  // The "aha" moment - what we learn by connecting these',
      '  }>',
      '}',
      '',
      'Rules:',
      '- Each connection must involve at least 2 different notes',
      '- Quotes must be short excerpts (under 100 words) from the actual note content',
      '- Insights should be non-obvious observations or extrapolations',
      '- Prioritize meaningful, thought-provoking connections over trivial ones',
      `- Return up to ${maxConnections} connections, ordered by significance`,
      focusInstruction,
    ].join('\n');

    const user = [
      'NOTES TO ANALYZE:',
      '',
      notesBlock,
      '',
      'Find meaningful connections between these notes:',
    ].join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_completion_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new Error(
        `OpenAI chat error: ${resp.status} ${resp.statusText} ${bodyText}`
      );
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = String(data.choices?.[0]?.message?.content ?? '');
    const parsed = tryParseJson(content);

    const connections = toConnectionsShape(parsed, chunksByNote);

    const out: NoteConnectionsResponse = {
      connections,
      analyzedNoteIds: noteIds,
      provider: 'openai',
      model,
    };

    return sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return sendJson(res, 500, { error: msg });
  }
}
