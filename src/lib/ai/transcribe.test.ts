import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

vi.mock('./config', () => ({ loadAiConfig: vi.fn() }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

import { loadAiConfig } from './config'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import { transcribeVoiceNote } from './transcribe'
import { inboundMediaPath } from '@/lib/whatsapp/persist-inbound-media'
import { OPENAI_URL } from './providers/openai'

const loadAiConfigMock = vi.mocked(loadAiConfig)
const getMediaUrlMock = vi.mocked(getMediaUrl)
const downloadMediaMock = vi.mocked(downloadMedia)

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-or-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function media(mimeType = 'audio/ogg; codecs=opus', bytes = 10) {
  getMediaUrlMock.mockResolvedValue({ url: 'https://cdn.meta/x', mimeType })
  downloadMediaMock.mockResolvedValue({
    buffer: Buffer.alloc(bytes),
    contentType: mimeType,
  })
}

/**
 * Minimal stand-in for the Supabase storage API that transcribeVoiceNote
 * reads from. By default the object is NOT in the bucket (a miss), which
 * exercises the Meta fallback. Pass `stored` for a storage hit, or
 * `throws` to simulate a storage outage.
 */
function makeDb(opts: { stored?: Blob; throws?: boolean } = {}) {
  const download = vi.fn(async () => {
    if (opts.throws) throw new Error('storage down')
    return opts.stored
      ? { data: opts.stored, error: null }
      : { data: null, error: { message: 'Object not found' } }
  })
  const from = vi.fn(() => ({ download }))
  return { db: { storage: { from } } as unknown as SupabaseClient, from, download }
}

function makeArgs(db: SupabaseClient = makeDb().db) {
  return {
    db,
    accountId: 'acc-1',
    mediaId: 'media-1',
    accessToken: 'wa-token',
    timeoutMs: 5000,
  }
}

let args = makeArgs()

let fetchMock: ReturnType<typeof vi.fn>

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200 },
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('AI_TRANSCRIPTION_MODEL', '')
  loadAiConfigMock.mockResolvedValue(config())
  media()
  args = makeArgs()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('transcribeVoiceNote', () => {
  it('skips when AI is not configured', async () => {
    loadAiConfigMock.mockResolvedValue(null)
    expect((await transcribeVoiceNote(args)).status).toBe('skipped')
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('skips for the anthropic provider', async () => {
    loadAiConfigMock.mockResolvedValue(config({ provider: 'anthropic' }))
    expect((await transcribeVoiceNote(args)).status).toBe('skipped')
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('skips unsupported mime types and oversized audio', async () => {
    media('audio/amr')
    expect((await transcribeVoiceNote(args)).status).toBe('skipped')
    media('audio/ogg', 5 * 1024 * 1024 + 1)
    expect((await transcribeVoiceNote(args)).status).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends input_audio to the shared chat URL and returns the trimmed transcript', async () => {
    fetchMock.mockResolvedValue(chatResponse('  hello there  '))
    const result = await transcribeVoiceNote(args)
    expect(result).toEqual({ status: 'done', transcript: 'hello there' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(OPENAI_URL)
    expect(opts.headers.Authorization).toBe('Bearer sk-or-test')
    const body = JSON.parse(opts.body)
    expect(body.model).toBe('google/gemini-2.5-flash')
    const audio = body.messages[0].content[1]
    expect(audio.type).toBe('input_audio')
    expect(audio.input_audio).toEqual({
      data: Buffer.alloc(10).toString('base64'),
      format: 'ogg',
    })
  })

  it('uses AI_TRANSCRIPTION_MODEL and treats empty content as a silent note', async () => {
    vi.stubEnv('AI_TRANSCRIPTION_MODEL', 'openai/gpt-4o-audio-preview')
    fetchMock.mockResolvedValue(chatResponse(''))
    expect(await transcribeVoiceNote(args)).toEqual({ status: 'done', transcript: '' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      'openai/gpt-4o-audio-preview',
    )
  })

  it('fails on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    )
    const result = await transcribeVoiceNote(args)
    expect(result.status).toBe('failed')
    expect(result).toMatchObject({ error: expect.stringContaining('bad key') })
  })

  it('fails when the media download throws', async () => {
    downloadMediaMock.mockRejectedValue(new Error('Media download failed: 404'))
    const result = await transcribeVoiceNote(args)
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('404') })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('reads persisted audio from storage first and never calls Meta', async () => {
    const stored = new Blob([Buffer.alloc(10)], { type: 'audio/ogg' })
    const { db, from, download } = makeDb({ stored })
    fetchMock.mockResolvedValue(chatResponse('from storage'))

    const result = await transcribeVoiceNote(makeArgs(db))

    expect(result).toEqual({ status: 'done', transcript: 'from storage' })
    expect(from).toHaveBeenCalledWith('inbound-media')
    expect(download).toHaveBeenCalledWith(inboundMediaPath('acc-1', 'media-1'))
    expect(getMediaUrlMock).not.toHaveBeenCalled()
    expect(downloadMediaMock).not.toHaveBeenCalled()
    const audio = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content[1]
    expect(audio.input_audio.data).toBe(Buffer.alloc(10).toString('base64'))
  })

  it('falls back to Meta when the object is not in storage', async () => {
    fetchMock.mockResolvedValue(chatResponse('from meta'))
    const result = await transcribeVoiceNote(args)
    expect(result).toEqual({ status: 'done', transcript: 'from meta' })
    expect(getMediaUrlMock).toHaveBeenCalledTimes(1)
    expect(downloadMediaMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to Meta (not a failure) when the storage read throws', async () => {
    const { db } = makeDb({ throws: true })
    fetchMock.mockResolvedValue(chatResponse('recovered'))
    const result = await transcribeVoiceNote(makeArgs(db))
    expect(result).toEqual({ status: 'done', transcript: 'recovered' })
    expect(getMediaUrlMock).toHaveBeenCalledTimes(1)
  })
})
