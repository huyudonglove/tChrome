export type { MemoryLayer, MemoryRecord } from "./memory/types.ts";
import type { ImageReference } from "./images/store.ts";
import type { QueryEvidence } from "./context/projections/queries.ts";
export type LedgerStatus = "idle" | "running" | "waiting_human" | "paused" | "failed";
export type TurnStatus = "assembling" | "inferring" | "completed" | "waiting_human" | "failed";

export type Session = {
  conversationId: string;
};

export type CurrentPage = {
  tabId: number;
  url: string;
  title: string;
  description: string;
};

export type UserInputRecord = { id: string; turnId: string; userInput: string; submittedAt: string };
export type GoalRecord = {
  id: string;
  parentId: string | null;
  goal: string;
  status: "active" | "completed" | "cancelled";
  turnId: string;
  sourceCallId: string;
  createdAt: string;
  updatedAt: string;
  planId: string | null;
  activePlanItemId: string | null;
};

export type ReflectHistoryItem = { id: string; text: string; focus?: string };
export type ReflectHistoryRecord = {
  turnId: string;
  items: ReflectHistoryItem[];
  at: string;
};

export type PageObservation = {
  id: string;
  turnId: string;
  observedAt: string;
  callId: string;
  batchId?: string;
  tabId: number;
  /** Tool name that produced this observation, e.g. page.get_summary. */
  type: string;
  /** Full tool return for this observation call. */
  result: unknown;
  goalId?: string | null;
  planId?: string | null;
  planItemId?: string | null;
};

/** Most recent model-returned tool batch; replaced before the next model request. */
export type LastAction = {
  batchId: string;
  turnId: string;
  calls: { callId: string; name: string; pageObservationId?: string }[];
};

export type PlanItemStatus = "todo" | "doing" | "done";
export type PlanStatus = "active" | "completed" | "cancelled";

export type PlanItem = {
  id: string;
  index: number;
  text: string;
  status: PlanItemStatus;
  expectedEffect?: string;
  verification?: string;
  blockedReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type Plan = {
  id: string;
  goalId: string;
  title?: string;
  status: PlanStatus;
  items: PlanItem[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type PlanHistoryType =
  | "plan_created"
  | "item_started"
  | "item_updated"
  | "item_completed"
  | "plan_completed"
  | "plan_cancelled"
  | "goal_completed"
  | "goal_cancelled";

export type PlanHistoryRecord = {
  id: string;
  planId: string;
  goalId: string;
  planItemId?: string;
  type: PlanHistoryType;
  before?: unknown;
  after?: unknown;
  reason?: string;
  at: string;
};

export type RuntimeExecutionContext = {
  goalId: string | null;
  activePlanId: string | null;
  activePlanItemId: string | null;
};

export type TabContext = { tabId: number; setAt: string } | null;

export type TabItem = { tabId: number; url: string; title: string; active: boolean };
export type OpenWindow = { windowId: number; focused: boolean; tabs: TabItem[] };
export type OpenTabs = { ok: true; windows: OpenWindow[] } | { ok: false; error: string };

export type Assembled = {
  baseToolsIds: string[];
  toolIds: string[];
  conversationMemoryIds: string[];
  projectMemoryIds: string[];
  mcpIds: string[];
  currentPage: (CurrentPage & Partial<PageObservation>) | null;
  pageObservedHistory: PageObservation[];
  openTabs: OpenTabs;
};

export type TurnOutput =
  | { kind: "tool"; name: string; callId: string }
  | { kind: "ask"; question: string }
  | { kind: "reply"; text: string }
  | { kind: "error"; faultCode: string; causeCode?: string; toolName?: string; detail?: string };

export type Turn = {
  goalChanges: GoalRecord[];
  turnId: string;
  conversationId: string;
  status: TurnStatus;
  createdAt: string;
  completedAt: string | null;
  input: { id: string; text: string; submittedAt: string };
  assembled: Assembled;
  reflect?: { id: string; text: string; focus?: string }[] | null;
  output: TurnOutput | null;
  // Optional for conversations saved before usage counters were introduced.
  usage?: { modelRequests: number; toolCalls: number };
};

export type ToolArguments = {
  reason?: string;
  [key: string]: unknown;
};

export type ToolReturn = {
  stage: "complete" | "truncated";
  totalChars: number;
  text: string;
};

export type ToolQueueItem = {
  batchId?: string;
  callId: string;
  name: string;
  arguments: ToolArguments;
};

export type ToolIOItem = ToolQueueItem & {
  turnId: string;
  return: ToolReturn;
  images?: ImageReference[];
  goalId?: string | null;
  planId?: string | null;
  planItemId?: string | null;
};

export type Ledger = {
  schemaVersion: 2;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  status: LedgerStatus;
  active: { turnId: string } | null;
  pendingAsk: { turnId: string; question: string } | null;
  turnIds: string[];
  loadedToolIds: string[];
  loadedSkillIds?: string[];
  userInputHistory: UserInputRecord[];
  reflectHistory: ReflectHistoryRecord[];
  goals: GoalRecord[];
  currentGoalId: string | null;
  plans: Plan[];
  planHistory: PlanHistoryRecord[];
  activePlanId: string | null;
  activePlanItemId: string | null;
  toolQueue: ToolQueueItem[];
  liveTools: { name: string; callId: string; reason?: string }[];
  toolIO: ToolIOItem[];
  lastAction: LastAction | null;
  contextTab: TabContext;
  notes: Record<string, string>;
  currentQuery: QueryEvidence | null;
  queryHistory: QueryEvidence[];
  windowChars: number;
  compressAt: number;
  memoryIds: { conversation: string[]; project: string[] };
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: ToolArguments;
};

export type ToolCallFault = {
  callId: string;
  name: string;
  rawArguments: string;
  detail: string;
};

/** Provider-side search evidence (e.g. Gemini google_search). Never executed by Runtime. */
export type ProviderGrounding = {
  name: string;
  queries: string[];
  sources: { title: string; uri: string }[];
};

export type CompletionResult = {
  finish: "tool_calls" | "stop" | "error";
  content: string;
  toolCalls: ToolCall[];
  toolCallFaults?: ToolCallFault[];
  grounding?: ProviderGrounding;
  attempts: number;
  parseOk: boolean;
  schemaOk: boolean;
  faultCode: string | null;
  missing: string[];
  badName?: string;
  detail?: string;
};

export type ChatMessage = {
  role: "system" | "user";
  content: string;
  images?: (ImageReference & { callId?: string })[];
};

export type ProviderExchange = {
  at: string;
  turnId: string;
  outbound: number;
  /** Content hash of the system window used for this exchange; full text lives in provider-system.md. */
  systemHash?: string;
  request: {
    toolIds: string[];
  };
  response: {
    providerCallIds?: Record<string, string>;
    finish: CompletionResult["finish"];
    toolCalls: ToolCall[];
    attempts: number;
    parseOk: boolean;
    schemaOk: boolean;
    faultCode: string | null;
    missing: string[];
    badName?: string;
    detail?: string;
  };
};

export type ExecutionMode = "parallel" | "serial";

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  /** Runtime default schedule; stripped before the provider request. */
  execution?: ExecutionMode;
};

export type Provider = {
  complete(input: {
    messages: ChatMessage[];
    tools: ChatTool[];
    imageContext?: { dataDir: string; conversationId: string };
    signal?: AbortSignal;
    toolChoice?: "auto" | "required";
  }): Promise<CompletionResult>;
};

export type BrowserResult = {
  ok: boolean;
  faultCode?: string;
  error?: string;
  tabId?: number | null;
  url?: string;
  title?: string;
  description?: string;
  text?: string;
};

export type BrowserHost = {
  readOpenTabs?(): Promise<OpenTabs>;
  execute(name: string, input: Record<string, unknown>): Promise<BrowserResult>;
  /** Optional tracked dispatch for heartbeat: exposes the bridge request id so job.stop can abort it. */
  executeTracked?(name: string, input: Record<string, unknown>): { id: string; result: Promise<BrowserResult> };
  abort?(scope?: string): void;
  abortById?(id: string): boolean;
  forScope?(scope: string): BrowserHost;
};

export type LogEvent = {
  at: string;
  kind: string;
  turnId?: string;
  data: Record<string, unknown>;
};

export type TurnReply = {
  conversationId: string;
  turnId: string;
  output: TurnOutput;
};
