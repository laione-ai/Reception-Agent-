// ============================================================
// Dental Agent — Type definitions.
//
// Shared types for the dental AI receptionist's tool-calling
// loop, session management, and provider integration.
// ============================================================

import type { AiProvider, AiUsage, ChatMessage } from '@/lib/ai/types';

// -------------------------------------------------------
// Tool definitions
// -------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** A tool call the model wants to make. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of executing a tool server-side. */
export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string; // JSON-stringified result
}

// -------------------------------------------------------
// Provider integration
// -------------------------------------------------------

export interface ToolCallingMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallingArgs {
  apiKey: string;
  model: string;
  messages: ToolCallingMessage[];
  tools: ToolDefinition[];
  timeoutMs: number;
}

export interface ToolCallingResult {
  /** The assistant's text response (empty when the model only makes tool calls). */
  text: string;
  /** Tool calls the model wants to execute. Empty when the model just responds with text. */
  toolCalls: ToolCall[];
  /** Token usage for this call. */
  usage: AiUsage | null;
  /** Whether the model decided it's done (no more tool calls, just text). */
  done: boolean;
}

// -------------------------------------------------------
// Agent engine
// -------------------------------------------------------

export interface AgentContext {
  accountId: string;
  conversationId: string;
  contactId: string;
  phone: string;
  configOwnerUserId: string;
}

/** The outcome of a single agent turn (one inbound message processed). */
export interface AgentTurnResult {
  /** Whether the agent consumed the message (should suppress other handlers). */
  consumed: boolean;
  /** The reply text sent to the patient (if any). */
  reply?: string;
  /** Whether the conversation was handed off to a human. */
  handedOff?: boolean;
  /** AI credentials used for this turn (reused for the post-reply summary refresh). */
  ai?: { provider: AiProvider; apiKey: string; model: string };
}

// Re-export for convenience
export type { AiUsage, ChatMessage };
