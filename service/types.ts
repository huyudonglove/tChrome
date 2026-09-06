export type LedgerStatus = "idle" | "running" | "waiting_human" | "paused" | "failed";
export type TurnStatus = "assembling" | "inferring" | "completed" | "waiting_human" | "failed";
export type MemoryLayer = "turn" | "conversation" | "project";

export type Session = {
  conversationId: string;
};

export type CurrentPage = {
  description: string;
  tab: number;
  url: string;
  title: string;
};

export type Assembled = {
  systemIds: string[];
  skillIds: string[];
  sopIds: string[];
  baseToolsIds: string[];
  toolIds: string[];
  turnMemoryIds: string[];
  conversationMemoryIds: string[];
  projectMemoryIds: string[];
  mcpIds: string[];
  currentPage: CurrentPage | null;
};

export type TurnOutput =
  | { kind: "tool"; name: string; callId: string }
  | { kind: "ask"; question: string }
  | { kind: "reply"; text: string }
  | { kind: "error"; faultCode: string };

export type Turn = {
  turnId: string;
  conversationId: string;
  status: TurnStatus;
  createdAt: string;
  completedAt: string | null;
  input: { text: string; submittedAt: string };
  assembled: Assembled;
  output: TurnOutput | null;
};

export type ToolArguments = {
  reason: string;
  affectsPage: boolean;
  [key: string]: unknown;
};

export type ToolReturn = {
  stage: "complete" | "truncated";
  totalChars: number;
  text: string;
};

export type ToolQueueItem = {
  callId: string;
  name: string;
  arguments: ToolArguments;
};

export type ToolIOItem = ToolQueueItem & {
  return: ToolReturn;
};

export type ObservationItem = {
  id: string;
  text: string;
  sourceCallIds: string[];
};

export type Ledger = {
  schemaVersion: 1;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  status: LedgerStatus;
  active: { turnId: string } | null;
  pendingAsk: { turnId: string; question: string } | null;
  turnIds: string[];
  userInputHistory: string[];
  toolQueue: ToolQueueItem[];
  toolIO: ToolIOItem[];
  observation: ObservationItem[];
  windowChars: number;
  compressAt: number;
  memoryIds: { turn: string[]; conversation: string[]; project: string[] };
  contextSummary: Record<string, unknown> | null;
};

export type MemoryRecord = {
  memoryId: string;
  layer: MemoryLayer;
  text: string;
  summary: string;
  compressed: boolean;
  createdAt: string;
  sourceCallId: string;
};

export type ObservationRecord = {
  observationId: string;
  text: string;
  full: string;
  sourceCallIds: string[];
  totalChars: number;
  createdAt: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: ToolArguments;
};

export type CompletionResult = {
  finish: "tool_calls" | "stop" | "error";
  content: string;
  toolCalls: ToolCall[];
  attempts: number;
  parseOk: boolean;
  schemaOk: boolean;
  faultCode: string | null;
  missing: string[];
};

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    parameters: Record<string, unknown>;
  };
};

export type Provider = {
  complete(input: {
    messages: ChatMessage[];
    tools: ChatTool[];
    baseToolsIds: string[];
    toolIds: string[];
  }): Promise<CompletionResult>;
};

export type BrowserResult = {
  ok: boolean;
  error?: string;
  tab?: number | null;
  url?: string;
  title?: string;
  description?: string;
  text?: string;
};

export type BrowserHost = {
  execute(name: string, input: Record<string, unknown>): Promise<BrowserResult>;
};

export type TurnReply = {
  conversationId: string;
  turnId: string;
  output: TurnOutput;
};
