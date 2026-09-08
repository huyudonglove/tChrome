import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";

const SERVICE = "http://127.0.0.1:18788";
const DOWN = "本机服务没开。终端跑 bun run service。";

type Output =
  | { kind: "reply"; text: string }
  | { kind: "ask"; question: string }
  | { kind: "error"; faultCode: string }
  | { kind: "tool"; name: string; callId: string };

type Message = { turnId?: string; role: "user" | "assistant" | "tool"; text: string; name?: string; live?: boolean };

type SessionView = {
  conversationId: string | null;
  status: string;
  pendingAsk: { turnId: string; question: string; choice: string[] } | null;
  liveTool: { name: string; callId: string } | null;
  messages: Message[];
};

type ConversationItem = {
  conversationId: string;
  updatedAt: string;
  status: string;
  preview: string;
};

const emptySession = (): SessionView => ({ conversationId: null, status: "idle", pendingAsk: null, liveTool: null, messages: [] });

const SUGGESTIONS = [
  { label: "看当前页", text: "当前页标题是什么" },
  { label: "打开网页", text: "打开 https://" },
  { label: "梳理想法", text: "帮我梳理一下当前想法和下一步" },
  { label: "对比页面", text: "对比两边标题" },
];

const statusText = (status: string) => ({
  idle: "就绪", running: "正在处理", waiting_human: "等待你的回复", paused: "已停止", failed: "未完成",
}[status] ?? "就绪");

const outputText = (output?: Output) => {
  if (!output) return "服务无响应";
  if (output.kind === "reply") return output.text;
  if (output.kind === "ask") return output.question;
  if (output.kind === "error") return output.faultCode === "stopped" ? "已停止" : `失败：${output.faultCode}`;
  return `${output.name} ${output.callId}`;
};

const Icon = ({ path }: { path: string }) => (
  <svg viewBox="0 0 24 24"><path d={path} /></svg>
);

const Avatar = ({ who }: { who: "user" | "assistant" }) => (
  who === "user"
    ? (
      <div className="message-avatar user">
        <svg className="face" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="9" r="3.2" />
          <path d="M6.2 18.6c.7-2.3 2.8-3.6 5.8-3.6s5.1 1.3 5.8 3.6" />
        </svg>
      </div>
    )
    : <div className="message-avatar">t</div>
);

const MdContent = ({ text }: { text: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = renderMarkdown(text);
  }, [text]);
  return <div className="message-content" ref={ref} />;
};

export function App() {
  const [session, setSession] = useState<SessionView>(emptySession());
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ conversationId: string; preview: string } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const sendingRef = useRef(false);
  const submission = useRef(0);
  const refreshVersion = useRef(0);
  const running = sending || session.status === "running";

  const loadAll = async () => {
    const generation = submission.current;
    const [sessionRes, listRes] = await Promise.all([
      fetch(`${SERVICE}/session`),
      fetch(`${SERVICE}/conversations`),
    ]);
    const next = await sessionRes.json() as SessionView;
    const listed = await listRes.json() as { items: ConversationItem[] };
    if (generation === submission.current) {
      setSession(next);
      setItems(listed.items ?? []);
    }
    return next;
  };

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const response = await fetch(`${SERVICE}/health`);
        const body = await response.json();
        if (alive) setStatus(body.ok ? "" : DOWN);
      } catch {
        if (alive) setStatus(DOWN);
      }
    };
    void loadAll().catch(() => setStatus(DOWN));
    probe();
    const timer = setInterval(probe, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const generation = submission.current;
        const version = refreshVersion.current;
        const response = await fetch(`${SERVICE}/session`);
        const next = await response.json() as SessionView;
        if (alive && generation === submission.current && version === refreshVersion.current) setSession(next);
      } catch {}
    };
    const timer = setInterval(tick, 700);
    tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running]);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const list = listRef.current;
    if (!list) return;
    followBottom.current = true;
    setShowJump(false);
    list.scrollTo({ top: list.scrollHeight, behavior });
  };

  useEffect(() => {
    if (!followBottom.current) return;
    requestAnimationFrame(() => scrollToBottom());
  }, [session.messages, sending]);

  const sendText = async (text: string) => {
    if (!text || sendingRef.current || session.status === "running") return;
    const currentSubmission = ++submission.current;
    setDraft("");
    sendingRef.current = true;
    setSending(true);
    setSession((current) => ({
      ...current,
      messages: [...current.messages, { role: "user", text }],
    }));
    void chrome.runtime.sendMessage({ type: "ping" }).catch(() => {});
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const currentTab = tab?.id
        ? { tab: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
        : null;
      const response = await fetch(`${SERVICE}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userInput: text, submittedAt: new Date().toISOString(), currentTab }),
      });
      const body = await response.json() as { output?: Output };
      if (submission.current !== currentSubmission) return;
      // The persisted session owns chat messages; appending the POST reply here
      // races with polling and briefly duplicates the final answer.
      refreshVersion.current++;
      await loadAll();
      if (submission.current !== currentSubmission) return;
      refreshVersion.current++;
      setStatus(!response.ok ? outputText(body.output) : "");
    } catch {
      if (submission.current === currentSubmission) setStatus(DOWN);
    } finally {
      if (submission.current === currentSubmission) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };

  const stopRun = async () => {
    try {
      const response = await fetch(`${SERVICE}/stop`, { method: "POST" });
      const stopped = await response.json() as SessionView;
      submission.current++;
      setSession(stopped);
      sendingRef.current = false;
      setSending(false);
    } catch {
      setStatus(DOWN);
    }
  };

  const openConversation = async (conversationId: string) => {
    const response = await fetch(`${SERVICE}/conversations/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    setSession(await response.json() as SessionView);
    setListOpen(false);
    followBottom.current = true;
    const listed = await fetch(`${SERVICE}/conversations`);
    setItems(((await listed.json()) as { items: ConversationItem[] }).items ?? []);
  };

  const startNew = async () => {
    const response = await fetch(`${SERVICE}/conversations/new`, { method: "POST" });
    setSession(await response.json() as SessionView);
    setListOpen(false);
    followBottom.current = true;
    const listed = await fetch(`${SERVICE}/conversations`);
    setItems(((await listed.json()) as { items: ConversationItem[] }).items ?? []);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.conversationId;
    setPendingDelete(null);
    const response = await fetch(`${SERVICE}/conversations/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    });
    setSession(await response.json() as SessionView);
    const listed = await fetch(`${SERVICE}/conversations`);
    setItems(((await listed.json()) as { items: ConversationItem[] }).items ?? []);
  };

  const filtered = items.filter((item) =>
    !query.trim() || item.conversationId.includes(query) || item.preview.includes(query)
  );

  return (
    <div className={`workspace-shell${listOpen ? " sessions-open" : ""}`}>
      <div className="chrome-top">
        <header className="app-bar">
          <div className="brand-mark">t</div>
          <div className="app-identity">
            <strong>{session.conversationId ?? "tChrome"}</strong>
            <small>{running ? "正在处理" : statusText(session.status)}</small>
          </div>
          <div className="app-actions">
            <button className="icon-button" type="button" title="会话" onClick={() => setListOpen((open) => !open)}>
              <Icon path="M4 6h16M4 12h16M4 18h10" />
            </button>
            <button className="icon-button accent" type="button" title="新会话" onClick={() => void startNew()}>
              <Icon path="M12 5v14M5 12h14" />
            </button>
          </div>
        </header>
        {status ? <div className={`status ${status === DOWN ? "down" : ""}`}>{status}</div> : null}
      </div>

      <div className="conversation-pane">
        <div
          className="messages"
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget;
            const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
            followBottom.current = nearBottom;
            setShowJump(!nearBottom);
          }}
        >
          {session.messages.length === 0 && !running ? (
            <div className="welcome">
              <div className="welcome-mark">t</div>
              <h1>今天想做<em>什么？</em></h1>
              <div className="quick-actions">
                {SUGGESTIONS.map((item) => (
                  <button key={item.label} type="button" onClick={() => setDraft(item.text)}>
                    <strong>{item.label}</strong>
                    <Icon path="M7 17L17 7M9 7h8v8" />
                  </button>
                ))}
              </div>
            </div>
          ) : session.messages.map((message, index) => (
            <article key={`${message.turnId ?? "local"}-${index}`} className={`message-row ${message.role}`}>
              {message.role === "tool" ? null : <Avatar who={message.role === "user" ? "user" : "assistant"} />}
              <div className="message-body">
                {message.role === "tool" ? (
                  <p className={`tool-step${message.live ? " live" : ""}`}>
                    {message.text || (message.live ? "正在处理" : "处理步骤")}
                    {message.live ? " …" : ""}
                  </p>
                ) : message.role === "assistant" && message.text
                  ? <MdContent text={message.text} />
                  : message.text ? <p>{message.text}</p> : null}
              </div>
            </article>
          ))}
          {running && !session.liveTool && session.messages.at(-1)?.role === "user" ? (
            <article className="message-row assistant muted">
              <Avatar who="assistant" />
              <div className="message-body"><p>在想</p></div>
            </article>
          ) : null}
        </div>
        {showJump ? (
          <button className="jump-to-bottom" type="button" onClick={() => scrollToBottom("smooth")}>
            <Icon path="M6 9l6 6 6-6" />
            <span>回到底部</span>
          </button>
        ) : null}
      </div>

      {session.pendingAsk ? (
        <section className="review-card interaction-card">
          <strong>{session.pendingAsk.choice.length ? "选择一项，或在下方输入回复" : "请在下方输入回复"}</strong>
          {session.pendingAsk.choice.length ? (
            <div className="interaction-items">
              {session.pendingAsk.choice.map((choice) => (
                <button key={choice} type="button" disabled={running} onClick={() => void sendText(choice)}>
                  <strong>{choice}</strong>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="composer-wrap">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendText(draft.trim());
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendText(draft.trim());
              }
            }}
            placeholder="说一句"
          />
          <button
            type={running ? "button" : "submit"}
            className={running ? "stop" : ""}
            title={running ? "停止" : "发送"}
            onClick={running ? () => void stopRun() : undefined}
          >
            {running ? <Icon path="M7 7h10v10H7z" /> : <Icon path="M5 12h14M13 6l6 6-6 6" />}
          </button>
        </form>
      </div>

      {listOpen ? (
        <>
          <button className="drawer-backdrop" type="button" onClick={() => setListOpen(false)} />
          <aside className="history-drawer">
            <div className="pane-header">
              <div>
                <strong>会话</strong>
                <span>history</span>
              </div>
            </div>
            <div className="session-search">
              <Icon path="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
            </div>
            <ul className="conversation-list">
              {filtered.map((item) => (
                <li
                  key={item.conversationId}
                  className={item.conversationId === session.conversationId ? "conversation-item active" : "conversation-item"}
                >
                  <button type="button" onClick={() => void openConversation(item.conversationId)}>
                    {item.preview || item.conversationId}
                  </button>
                  <button
                    type="button"
                    className="delete"
                    onClick={() => setPendingDelete({ conversationId: item.conversationId, preview: item.preview || item.conversationId })}
                  >
                    删
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </>
      ) : null}

      {pendingDelete ? (
        <div className="confirm-layer">
          <button className="confirm-backdrop" type="button" onClick={() => setPendingDelete(null)} />
          <div className="confirm-card">
            <strong>删除会话</strong>
            <p>删掉「{pendingDelete.preview}」？落盘一并清掉。</p>
            <div>
              <button type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" className="danger" onClick={() => void confirmDelete()}>删除</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
