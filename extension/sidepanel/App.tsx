import { useEffect, useRef, useState } from "react";

const SERVICE = "http://127.0.0.1:18788";
const DOWN = "本机服务没开。终端跑 bun run service。";

type Output =
  | { kind: "reply"; text: string }
  | { kind: "ask"; question: string }
  | { kind: "error"; faultCode: string }
  | { kind: "tool"; name: string; callId: string };

type Message = { turnId?: string; role: "user" | "assistant"; text: string };

type SessionView = {
  conversationId: string | null;
  status: string;
  pendingAsk: { turnId: string; question: string; choice: string[] } | null;
  messages: Message[];
};

type ConversationItem = {
  conversationId: string;
  updatedAt: string;
  status: string;
  preview: string;
};

const emptySession = (): SessionView => ({ conversationId: null, status: "idle", pendingAsk: null, messages: [] });

const outputText = (output?: Output) => {
  if (!output) return "服务无响应";
  if (output.kind === "reply") return output.text;
  if (output.kind === "ask") return output.question;
  if (output.kind === "error") return `失败：${output.faultCode}`;
  return `${output.name} ${output.callId}`;
};

export function App() {
  const [session, setSession] = useState<SessionView>(emptySession());
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const loadAll = async () => {
    const [sessionRes, listRes] = await Promise.all([
      fetch(`${SERVICE}/session`),
      fetch(`${SERVICE}/conversations`),
    ]);
    const next = await sessionRes.json() as SessionView;
    const listed = await listRes.json() as { items: ConversationItem[] };
    setSession(next);
    setItems(listed.items ?? []);
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [session.messages]);

  const sendText = async (text: string) => {
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setSession((current) => ({
      ...current,
      messages: [...current.messages, { role: "user", text }],
    }));
    const ping = setInterval(() => {
      chrome.runtime.sendMessage({ type: "ping" }).catch(() => {});
    }, 1000);
    try {
      const response = await fetch(`${SERVICE}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userInput: text, submittedAt: new Date().toISOString() }),
      });
      const body = await response.json() as { output?: Output };
      setSession((current) => ({
        ...current,
        messages: [...current.messages, { role: "assistant", text: outputText(body.output) }],
      }));
      await loadAll();
      setStatus("");
    } catch {
      setStatus(DOWN);
    } finally {
      clearInterval(ping);
      setSending(false);
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
    const listed = await fetch(`${SERVICE}/conversations`);
    setItems(((await listed.json()) as { items: ConversationItem[] }).items ?? []);
  };

  const startNew = async () => {
    const response = await fetch(`${SERVICE}/conversations/new`, { method: "POST" });
    setSession(await response.json() as SessionView);
    setListOpen(false);
    const listed = await fetch(`${SERVICE}/conversations`);
    setItems(((await listed.json()) as { items: ConversationItem[] }).items ?? []);
  };

  return (
    <div className="app">
      <header className="bar">
        <button type="button" className="ghost" onClick={() => setListOpen((open) => !open)}>
          {session.conversationId ?? "新会话"}
        </button>
        <button type="button" className="ghost" onClick={() => void startNew()}>新建</button>
      </header>
      {listOpen ? (
        <div className="drawer">
          {items.map((item) => (
            <button
              key={item.conversationId}
              type="button"
              className={item.conversationId === session.conversationId ? "item active" : "item"}
              onClick={() => void openConversation(item.conversationId)}
            >
              <span>{item.conversationId}</span>
              <span className="muted">{item.preview}</span>
            </button>
          ))}
        </div>
      ) : null}
      {status ? <div className="banner">{status}</div> : null}
      <div className="messages" ref={listRef}>
        {session.messages.map((message, index) => (
          <div key={`${message.turnId ?? "local"}-${index}`} className={`row ${message.role}`}>{message.text}</div>
        ))}
      </div>
      {session.pendingAsk?.choice.length ? (
        <div className="choices">
          {session.pendingAsk.choice.map((choice) => (
            <button key={choice} type="button" disabled={sending} onClick={() => void sendText(choice)}>{choice}</button>
          ))}
        </div>
      ) : null}
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
        <button type="submit" disabled={sending}>发送</button>
      </form>
    </div>
  );
}
