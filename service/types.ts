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

export type ReflectHistoryItem = { id: string; text: string; focus?: string };
export type ReflectHistoryRecord = {
  turnId: string;
  items: ReflectHistoryItem[];
  at: string;
};

export type Observation = {  id: string;
  turnId: string;
  observedAt: string;
  callId: string;
  batchId?: string;
  tabId?: number;
  /** Tool name that produced this observation, e.g. page_get_summary or execute_javascript. */
  type: string;
  /** Full tool return for this observation call. */
  result: unknown;
  taskId?: string | null;
  taskItemId?: string | null;
  /** 1-based turn ordinal this observation was written in. */
  writtenTurn?: number;
  /** Last 1-based turn ordinal in which this observation may still hold; undefined means it never expires. */
  validUntilTurn?: number;
};

/** 因果工作区条目：一次出网做了什么（op）、得到什么结论（value）、涉及哪些文件（files，可带行区间），由 workspace_write 写入，跟 turn 走。 */
export type WorkspaceEntry = {
  id: string;
  turnId: string;
  /** 本 Conversation 内第几次模型请求（b01、b02…）。 */
  boundId: string;
  /** 写入本次 ws 的工具调用。 */
  callId: string;
  /** 被总结的那批调用。 */
  callIds: string[];
  op: string;
  value: string;
  /** 涉及的文件路径（可选，可带行区间如 src/auth.ts:120-180），用于按文件回查因果。 */
  files?: string[];
};

/** Runtime 运行时提醒：与 <turn> 平级的新模块，不再零散缀在各条返回后面。
 * 一次性提醒只出现在返回里，不进这里；半长久（turn 级）随 turn 消亡；长久的修好即消。 */
export type RuntimeNoticeScope = "turn" | "persistent";
export type RuntimeNotice = {
  id: string;
  /** budget | observation | reflect | compress | rotate | workspace */
  kind: string;
  scope: RuntimeNoticeScope;
  text: string;
};

/** Most recent model-returned tool batch; replaced before the next model request. */
export type LastAction = {
  batchId: string;
  turnId: string;
  calls: { callId: string; name: string; observationId?: string }[];
};

export type TaskItemStatus = "todo" | "doing" | "done";
export type TaskStatus = "active" | "paused" | "completed" | "cancelled";

export type TaskItem = {
  id: string;
  index: number;
  text: string;
  status: TaskItemStatus;
  expectedEffect?: string;
  verification?: string;
  blockedReason?: string;
  outcome?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type Task = {
  id: string;
  title?: string;
  status: TaskStatus;
  items: TaskItem[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  createdTurnId?: string;
  updatedTurnId?: string;
};

export type TaskHistoryType =
  | "task_created"
  | "item_started"
  | "item_updated"
  | "item_completed"
  | "task_completed"
  | "task_cancelled"
  | "task_paused"
  | "task_resumed";

export type TaskHistoryRecord = {
  id: string;
  taskId: string;
  taskItemId?: string;
  type: TaskHistoryType;
  before?: unknown;
  after?: unknown;
  reason?: string;
  at: string;
  /** Turn that caused this event; used for turn-scoped window filter and compression. */
  turnId?: string;
};

export type RuntimeExecutionContext = {
  activeTaskId: string | null;
  activeTaskItemId: string | null;
};

export type TabContext = { tabId: number; setAt: string } | null;

export type TabItem = { tabId: number; url: string; title: string; active: boolean };
export type OpenWindow = { windowId: number; focused: boolean; tabs: TabItem[] };
export type CurrentTabs = { ok: true; windows: OpenWindow[] } | { ok: false; error: string };

export type Assembled = {
  baseToolsIds: string[];
  toolIds: string[];
  conversationMemoryIds: string[];
  projectMemoryIds: string[];
  mcpIds: string[];
  currentPage: (CurrentPage & Partial<Observation>) | null;
  observations: Observation[];
  /** 因果工作区：本轮写下的 ws 条目，窗口不限量，压缩时跟 turn 一起归档。 */
  workspace: WorkspaceEntry[];
  currentTabs: CurrentTabs;
};

export type TurnStopReason =
  | { kind: "tool"; name: string; callId: string }
  | { kind: "ask"; question: string }
  | { kind: "reply"; text: string }
  | { kind: "interrupted"; initiatedBy: "user" | "budget" | "service"; detail?: string }
  // The turn was force-closed by the single-turn rotation gate; the caller may open
  // a continuation turn. turnChars is the window size at closure, turnDeltaChars the
  // part this turn itself injected.
  | { kind: "rotated"; turnChars: number; turnDeltaChars: number; detail?: string }
  | { kind: "error"; faultCode: string; causeCode?: string; toolName?: string; detail?: string };

export type Turn = {
  turnId: string;
  conversationId: string;
  status: TurnStatus;
  createdAt: string;
  completedAt: string | null;
  input: { id: string; text: string; submittedAt: string };
  assembled: Assembled;
  reflect?: { id: string; text: string; focus?: string }[] | null;
  actions?: { id: string; text: string; at: string }[] | null;
  stopReason: TurnStopReason | null;
  // Optional for conversations saved before usage counters were introduced.
  usage?: { modelRequests: number; toolCalls: number };
};

export type ToolArguments = {
  reason?: string;
  /** Retain this call in its turn's model context until compression covers it. */
  keepInCalls?: boolean;
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
  imagesError?: string;
  runtimeHints?: string[];
  taskId?: string | null;
  taskItemId?: string | null;
  /** Effective risk level: the model's own value, otherwise the tool's fixed level. */
  risk?: string;
  /** Whether the effective risk came from the model or from the tool's fixed level. */
  riskSource?: "model" | "fixed";
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
  tasks: Task[];
  taskHistory: TaskHistoryRecord[];
  activeTaskId: string | null;
  activeTaskItemId: string | null;
  toolQueue: ToolQueueItem[];
  liveTools: { name: string; callId: string; reason?: string }[];
  toolIO: ToolIOItem[];
  lastAction: LastAction | null;
  /** Runtime 运行时提醒（与 turn 平级展示）；turn 级随 turn 消亡。 */
  runtimeNotices: RuntimeNotice[];
  /** 本 Conversation 内模型请求计数（boundId 来源）。 */
  boundSeq: number;
  contextTab: TabContext;
  notes: Record<string, { id: string; value: string }>;
  queryHistory: QueryEvidence[];
  windowChars: number;
  compressAt: number;
  /** Window size at which a turn whose own injected content crosses it is force-closed. */
  turnRotateAt: number;
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
  readCurrentTabs?(): Promise<CurrentTabs>;
  execute(name: string, input: Record<string, unknown>): Promise<BrowserResult>;
  /** Optional tracked dispatch for heartbeat: exposes the bridge request id so job_stop can abort it. */
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
  stopReason: TurnStopReason;
};
