import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: vi.fn(),
}));
vi.mock('@/lib/ai/providers/openai', () => ({
  generateOpenAi: vi.fn(),
}));
vi.mock('@/lib/ai/providers/anthropic', () => ({
  generateAnthropic: vi.fn(),
}));

import { buildConversationContext } from '@/lib/ai/context';
import { generateOpenAi } from '@/lib/ai/providers/openai';
import { generateAnthropic } from '@/lib/ai/providers/anthropic';
import { loadAgentMemory, refreshConversationSummary, RECENT_MESSAGE_LIMIT } from '../memory';

// -------------------------------------------------------
// Fake Supabase: each from(table) call consumes the next queued
// result for that table. Every builder method is chainable and
// the chain is awaitable. Calls are recorded for assertions.
// -------------------------------------------------------

type Result = { data: unknown; error: unknown };

function fakeDb(queues: Record<string, Result[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const result = queues[table]?.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'lt', 'gt', 'order', 'limit', 'range', 'update', 'maybeSingle']) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return chain;
        };
      }
      chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

function msg(i: number, overrides: Record<string, unknown> = {}) {
  return {
    sender_type: i % 2 === 0 ? 'customer' : 'agent',
    content_type: 'text',
    content_text: `message ${i}`,
    created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    ...overrides,
  };
}

const AI = { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-test' };
const WINDOW_EDGE = { data: [{ created_at: 'cutoff-ts' }, { created_at: 'older-ts' }], error: null };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadAgentMemory', () => {
  it('returns summary + recent history', async () => {
    const history = [{ role: 'user' as const, content: 'hi' }];
    vi.mocked(buildConversationContext).mockResolvedValue(history);
    const { db } = fakeDb({ conversations: [{ data: { ai_summary: '  - Name: Jan  ' }, error: null }] });

    const memory = await loadAgentMemory(db, 'conv-1');

    expect(buildConversationContext).toHaveBeenCalledWith(db, 'conv-1', RECENT_MESSAGE_LIMIT);
    expect(memory).toEqual({ summary: '- Name: Jan', history });
  });

  it('returns null summary when blank or missing', async () => {
    vi.mocked(buildConversationContext).mockResolvedValue([]);
    const { db } = fakeDb({
      conversations: [
        { data: { ai_summary: '   ' }, error: null },
        { data: null, error: null },
      ],
    });

    expect((await loadAgentMemory(db, 'conv-1')).summary).toBeNull();
    expect((await loadAgentMemory(db, 'conv-1')).summary).toBeNull();
  });

  it('returns null summary when the summary query errors', async () => {
    vi.mocked(buildConversationContext).mockResolvedValue([]);
    const { db } = fakeDb({ conversations: [{ data: null, error: { message: 'boom' } }] });

    expect(await loadAgentMemory(db, 'conv-1')).toEqual({ summary: null, history: [] });
  });

  it('returns empty history when the history query errors', async () => {
    vi.mocked(buildConversationContext).mockRejectedValue(new Error('boom'));
    const { db } = fakeDb({ conversations: [{ data: { ai_summary: '- notes' }, error: null }] });

    expect(await loadAgentMemory(db, 'conv-1')).toEqual({ summary: '- notes', history: [] });
  });
});

describe('refreshConversationSummary', () => {
  it('no-ops when the conversation fits in the recent window', async () => {
    const { db } = fakeDb({
      conversations: [{ data: { ai_summary: null, ai_summary_through: null }, error: null }],
      messages: [{ data: [{ created_at: 'only-one' }], error: null }],
    });

    await refreshConversationSummary(db, 'conv-1', AI);

    expect(generateOpenAi).not.toHaveBeenCalled();
  });

  it('no-ops when fewer than the batch threshold of older messages exist', async () => {
    const { db } = fakeDb({
      conversations: [{ data: { ai_summary: null, ai_summary_through: null }, error: null }],
      messages: [WINDOW_EDGE, { data: Array.from({ length: 9 }, (_, i) => msg(i)), error: null }],
    });

    await refreshConversationSummary(db, 'conv-1', AI);

    expect(generateOpenAi).not.toHaveBeenCalled();
  });

  it('summarises older messages with the previous notes and saves the result', async () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => msg(i)),
      msg(9, { content_type: 'audio', content_text: ' call me tomorrow ' }),
      msg(10, { content_text: '   ' }),
    ];
    const { db, calls } = fakeDb({
      conversations: [
        { data: { ai_summary: '- Name: Jan (confirmed)', ai_summary_through: 'through-ts' }, error: null },
        { data: null, error: null },
      ],
      messages: [WINDOW_EDGE, { data: rows, error: null }],
    });
    vi.mocked(generateOpenAi).mockResolvedValue({ text: '  - Name: Jan\n- Wants a cleaning  ', usage: null });

    await refreshConversationSummary(db, 'conv-1', AI);

    expect(generateOpenAi).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateOpenAi).mock.calls[0][0];
    expect(args).toMatchObject({ apiKey: 'sk-test', model: 'gpt-test' });
    expect(args.timeoutMs).toBeGreaterThan(0);
    expect(args.messages).toHaveLength(1);
    const content = args.messages[0].content;
    expect(content).toContain('Previous notes:\n- Name: Jan (confirmed)');
    expect(content).toContain('Patient: message 0');
    expect(content).toContain('Clinic: message 1');
    expect(content).toContain('Clinic: [Voice note] call me tomorrow');

    // Only messages older than the window and newer than the last summary.
    expect(calls).toContainEqual({ table: 'messages', method: 'lt', args: ['created_at', 'cutoff-ts'] });
    expect(calls).toContainEqual({ table: 'messages', method: 'gt', args: ['created_at', 'through-ts'] });

    const update = calls.find((c) => c.table === 'conversations' && c.method === 'update');
    expect(update?.args[0]).toEqual({
      ai_summary: '- Name: Jan\n- Wants a cleaning',
      ai_summary_through: rows[rows.length - 1].created_at,
    });
  });

  it('dispatches to Anthropic when configured', async () => {
    const { db } = fakeDb({
      conversations: [{ data: null, error: null }, { data: null, error: null }],
      messages: [WINDOW_EDGE, { data: Array.from({ length: 10 }, (_, i) => msg(i)), error: null }],
    });
    vi.mocked(generateAnthropic).mockResolvedValue({ text: '- notes', usage: null });

    await refreshConversationSummary(db, 'conv-1', { ...AI, provider: 'anthropic' });

    expect(generateAnthropic).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateAnthropic).mock.calls[0][0].messages[0].content).toContain(
      'Previous notes:\n(none)',
    );
  });

  it('swallows provider errors without writing', async () => {
    const { db, calls } = fakeDb({
      conversations: [{ data: null, error: null }],
      messages: [WINDOW_EDGE, { data: Array.from({ length: 12 }, (_, i) => msg(i)), error: null }],
    });
    vi.mocked(generateOpenAi).mockRejectedValue(new Error('rate limited'));

    await expect(refreshConversationSummary(db, 'conv-1', AI)).resolves.toBeUndefined();

    expect(calls.some((c) => c.method === 'update')).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '[dental agent] refreshConversationSummary error:',
      expect.any(Error),
    );
  });
});
