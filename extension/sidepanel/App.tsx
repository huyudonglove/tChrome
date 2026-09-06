import { useEffect, useRef, useState } from "react";

const SERVICE = "http://127.0.0.1:18788";
const DOWN = "本机服务没开。终端跑 bun run service。";

type Output =
  | { kind: "reply"; text: string }
  | { kind: "ask"; question: string }
  | { kind: "error"; faultCode: string }
  | { kind: "tool"; name: string; callId: string };

type Message = { id: string; role: "user" | "assistant"; text: string };

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

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
    probe();
    const timer = setInterval(probe, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    const local: Message = { id: `u-${Date.now()}`, role: "user", text };
    setMessages((current) => [...current, local]);
    try {
      const response = await fetch(`${SERVICE}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userInput: text, submittedAt: new Date().toISOString() }),
      });
      const body = await response.json() as { output?: Output };
      const output = body.output;
      const reply = !output
        ? "服务无响应"
        : output.kind === "reply"
          ? output.text
          : output.kind === "ask"
            ? output.question
            : output.kind === "error"
              ? `失败：${output.faultCode}`
              : `${output.name} ${output.callId}`;
      setMessages((current) => [...current, { id: `a-${Date.now()}`, role: "assistant", text: reply }]);
      setStatus("");
    } catch {
      setStatus(DOWN);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app">
      {status ? <div className="banner">{status}</div> : null}
      <div className="messages" ref={listRef}>
        {messages.map((message) => (
          <div key={message.id} className={`row ${message.role}`}>{message.text}</div>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="说一句"
        />
        <button type="submit" disabled={sending}>发送</button>
      </form>
    </div>
  );
}
