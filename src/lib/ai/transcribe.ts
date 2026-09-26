import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import { loadAiConfig } from './config'
import { OPENAI_URL } from './providers/openai'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Speech-to-text for inbound WhatsApp voice notes. Goes through the
// same chat-completions URL (OPENAI_BASE_URL → OpenRouter) and the same
// account key as every other AI call, sending the audio as an
// `input_audio` content part to an audio-capable model. Anthropic keys
// can't transcribe.
// ============================================================

export type VoiceNoteResult =
  | { status: 'done'; transcript: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

const MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MODEL = 'google/gemini-2.5-flash'
const MAX_TRANSCRIPT_TOKENS = 4096

const PROMPT =
  'Transcribe this voice note verbatim. The speaker is most likely speaking ' +
  'English; if not, transcribe in the language spoken. Return only the ' +
  'transcript text with no commentary. If there is no speech, return nothing.'

// input_audio formats OpenRouter accepts, keyed by base MIME type.
const FORMAT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[]
}

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err)

/** Download a WhatsApp voice note from Meta and transcribe it. Never throws. */
export async function transcribeVoiceNote(args: {
  db: SupabaseClient
  accountId: string
  mediaId: string
  accessToken: string // decrypted WhatsApp access token
  timeoutMs: number
}): Promise<VoiceNoteResult> {
  const { db, accountId, mediaId, accessToken, timeoutMs } = args

  try {
    let config
    try {
      config = await loadAiConfig(db, accountId)
    } catch (err) {
      return { status: 'failed', error: `AI config: ${errMsg(err)}` }
    }
    if (!config) return { status: 'skipped', reason: 'AI not configured' }
    if (config.provider !== 'openai') {
      return { status: 'skipped', reason: `provider ${config.provider} cannot transcribe` }
    }

    let buffer: Buffer
    let mimeType: string
    try {
      const media = await getMediaUrl({ mediaId, accessToken })
      const dl = await downloadMedia({ downloadUrl: media.url, accessToken })
      buffer = dl.buffer
      mimeType = media.mimeType
    } catch (err) {
      return { status: 'failed', error: `Media download: ${errMsg(err)}` }
    }

    if (buffer.length > MAX_BYTES) {
      return { status: 'skipped', reason: `audio too large (${buffer.length} bytes)` }
    }

    // WhatsApp sends e.g. "audio/ogg; codecs=opus" — strip params.
    const baseMime = mimeType.split(';')[0].trim().toLowerCase()
    const format = FORMAT_BY_MIME[baseMime]
    if (!format) return { status: 'skipped', reason: `unsupported audio type ${baseMime}` }

    let res: Response
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.AI_TRANSCRIPTION_MODEL || DEFAULT_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                {
                  type: 'input_audio',
                  input_audio: { data: buffer.toString('base64'), format },
                },
              ],
            },
          ],
          temperature: 0,
          max_completion_tokens: MAX_TRANSCRIPT_TOKENS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      return { status: 'failed', error: toNetworkError(err).message }
    }
    if (!res.ok) {
      return { status: 'failed', error: (await providerHttpError('OpenRouter', res)).message }
    }

    const data = (await res.json()) as ChatResponse
    const message = data?.choices?.[0]?.message
    // Empty content is a valid result (a silent voice note).
    if (!message || (message.content != null && typeof message.content !== 'string')) {
      return { status: 'failed', error: 'Transcription response missing text' }
    }
    return { status: 'done', transcript: (message.content ?? '').trim() }
  } catch (err) {
    return { status: 'failed', error: errMsg(err) }
  }
}
