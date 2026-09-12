import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import { DOWN, requestJSON, errorText } from "./service";
import { shouldSubmitOnEnter, stopCurrentSession } from "./interactions";
import { LibraryPanel } from "./LibraryPanel";

type Output =
  | { kind: "reply"; text: string }
  | { kind: "ask"; question: string }
  | { kind: "error"; faultCode: string }
  | { kind: "tool"; name: string; callId: string };

type Message = { turnId?: string; role: "user" | "assistant" | "tool"; text: string; name?: string; live?: boolean };

type SessionView = {
  conversationId: string | null;
  status: string;
  activity: { kind: "compressing"; phase: "history" | "current" | "summaries" | null } | null;
  pendingAsk: { turnId: string; question: string; choice: string[] } | null;
  liveTool: { name: string; callId: string } | null;
  messages: Message[];
};

type ConnectionView = {
  enabled: boolean;
  provider: string;
  providers: { id: string; label: string; model: string }[];
};

type ConversationItem = {
  conversationId: string;
  updatedAt: string;
  status: string;
  preview: string;
};

const emptySession = (): SessionView => ({ conversationId: null, status: "idle", activity: null, pendingAsk: null, liveTool: null, messages: [] });

const SUGGESTIONS = [
  { label: "看当前页", text: "当前页标题是什么" },
  { label: "打开网页", text: "打开 https://" },
  { label: "梳理想法", text: "帮我梳理一下当前想法和下一步" },
  { label: "对比页面", text: "对比两边标题" },
];

const statusText = (status: string) => ({
  idle: "就绪", running: "正在处理", waiting_human: "等待你的回复", paused: "已停止", failed: "未完成",
}[status] ?? "就绪");

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
    : <div className="message-avatar"><img className="brand-logo" src="./icons/icon-48.png" alt="tChrome" /></div>
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
  const [syncError, setSyncError] = useState("");
  const [listError, setListError] = useState("");
  const [serviceDown, setServiceDown] = useState(false);
  const [extensionIssue, setExtensionIssue] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  useEffect(() => { if (!listOpen) setSettingsOpen(false); }, [listOpen]);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ conversationId: string; preview: string } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const sendingRef = useRef(false);
  const submission = useRef(0);
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const connectionUpdating = useRef(false);
  const refreshVersion = useRef(0);
  const switching = useRef(false);
  const running = sending || session.status === "running";
  const compressing = session.status === "running" && session.activity?.kind === "compressing";
  const compressionText = session.activity?.phase
    ? { history: "正在压缩历史记录", current: "正在压缩当前轮记录", summaries: "正在压缩已有摘要" }[session.activity.phase]
    : "正在压缩上下文";

  const loadAll = async () => {
    const generation = submission.current;
    const version = refreshVersion.current;
    const valid = () => !switching.current && generation === submission.current && version === refreshVersion.current;
    await Promise.allSettled([
      requestJSON<SessionView>("/session").then(next => {
        if (valid()) { setSession(next); setSyncError(""); }
      }).catch(error => { if (valid()) setSyncError(errorText(error)); }),
      requestJSON<{ items: ConversationItem[] }>("/conversations").then(listed => {
        if (valid()) { setItems(listed.items ?? []); setListError(""); }
      }).catch(error => { if (valid()) setListError(errorText(error)); }),
    ]);
  };

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const body = await requestJSON<{ ok: boolean; extension?: { status: string; error?: string } }>("/health");
        if (alive) {
          setServiceDown(!body.ok);
          setExtensionIssue(!body.extension ? "本地服务版本过旧，请重启服务并重新加载扩展。"
            : body.extension.status === "mismatch" ? body.extension.error || "扩展版本不一致，请重新打包并加载扩展。"
            : body.extension.status === "disconnected" ? "浏览器执行器已断开，请重新加载扩展。" : "");
        }
      } catch {
        if (alive) setServiceDown(true);
      }
    };
    void loadAll();
    probe();
    const timer = setInterval(probe, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || switching.current) return;
      inFlight = true;
      const generation = submission.current;
      const version = refreshVersion.current;
      const valid = () => !switching.current && alive && generation === submission.current && version === refreshVersion.current;
      try {
        const next = await requestJSON<SessionView>("/session");
        if (valid()) { setSession(next); setSyncError(""); }
      } catch (error) {
        if (valid()) setSyncError(errorText(error));
      } finally { inFlight = false; }
    };
    const timer = setInterval(tick, running ? 700 : 3000);
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
    if (!text) return;
    if (switching.current || sendingRef.current || session.status === "running") {
      setStatus(switching.current ? "会话切换中，请稍后发送" : "正在处理，请等待完成或先停止");
      return;
    }
    setStatus("");
    const currentSubmission = ++submission.current;
    setDraft("");
    sendingRef.current = true;
    setSending(true);
    setSession((current) => ({
      ...current,
      messages: [...current.messages, { role: "user", text }],
    }));
    let requestStarted = false;
    try {
      void chrome.runtime.sendMessage({ type: "ping" }).catch(() => {});
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const currentTab = tab?.id
        ? { tab: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
        : null;
      requestStarted = true;
      await requestJSON<{ output?: Output }>("/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: session.conversationId, userInput: text, submittedAt: new Date().toISOString(), currentTab }),
      });

      if (submission.current !== currentSubmission) return;
      // The persisted session owns chat messages; appending the POST reply here
      // races with polling and briefly duplicates the final answer.
      refreshVersion.current++;
      await loadAll();
      if (submission.current !== currentSubmission) return;
      refreshVersion.current++;
      setStatus("");
    } catch (error) {
      if (submission.current === currentSubmission) {
        if (requestStarted) {
          setSyncError(`发送请求出错，正在同步会话状态：${errorText(error)}`);
          refreshVersion.current++;
          void loadAll();
        } else setStatus(errorText(error));
        // After dispatch, the service may already own the message even if
        // the response or subsequent session refresh fails.
        if (!requestStarted) setDraft((current) => current || text);
      }
    } finally {
      if (submission.current === currentSubmission) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };

  const stopRun = () => stopCurrentSession<SessionView>({
    conversationId: session.conversationId,
    submission,
    switching,
    onStopped: (stopped) => {
      refreshVersion.current++;
      setSession(stopped);
      setStatus("");
      setSyncError("");
      sendingRef.current = false;
      setSending(false);
    },
    onError: (error) => setStatus(errorText(error)),
  });

  const openConversation = async (conversationId: string) => {
    if (switching.current) return;
    switching.current = true;
    try {
    submission.current++;
    refreshVersion.current++;
    sendingRef.current = true;
    setSending(true);
    const next = await requestJSON<SessionView>("/conversations/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    submission.current++;
    refreshVersion.current++;
    setSession(next);
    sendingRef.current = false;
    setSending(false);
    setListOpen(false);
    setDraft("");
    setStatus("");
    setShowJump(false);
    followBottom.current = true;
    const listed = await requestJSON<{ items: ConversationItem[] }>("/conversations");
    setItems(listed.items ?? []);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      switching.current = false;
      sendingRef.current = false;
      setSending(false);
    }
  };

  const startNew = async () => {
    if (switching.current) return;
    switching.current = true;
    try {
    submission.current++;
    refreshVersion.current++;
    sendingRef.current = true;
    setSending(true);
    const next = await requestJSON<SessionView>("/conversations/new", { method: "POST" });
    submission.current++;
    refreshVersion.current++;
    setSession(next);
    sendingRef.current = false;
    setSending(false);
    setListOpen(false);
    setDraft("");
    setStatus("");
    setShowJump(false);
    followBottom.current = true;
    const listed = await requestJSON<{ items: ConversationItem[] }>("/conversations");
    setItems(listed.items ?? []);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      switching.current = false;
      sendingRef.current = false;
      setSending(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || switching.current) return;
    switching.current = true;
    submission.current++;
    refreshVersion.current++;
    sendingRef.current = true;
    setSending(true);
    try {
    const id = pendingDelete.conversationId;
    setPendingDelete(null);
    const next = await requestJSON<SessionView>("/conversations/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    });
    submission.current++;
    refreshVersion.current++;
    if (next.conversationId !== session.conversationId) {
      setDraft("");
      setStatus("");
      setShowJump(false);
      followBottom.current = true;
    }
    setSession(next);
    sendingRef.current = false;
    setSending(false);
    const listed = await requestJSON<{ items: ConversationItem[] }>("/conversations");
    setItems(listed.items ?? []);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      switching.current = false;
      sendingRef.current = false;
      setSending(false);
    }
  };

  useEffect(() => {
    let alive = true;
    if (!serviceDown) {
      void requestJSON<ConnectionView>("/connection").then((value) => {
        if (alive) {
          setConnection(value);
          setConnectionError("");
        }
      }).catch((error) => {
        if (alive) setConnectionError(errorText(error));
      });
    }
    return () => { alive = false; };
  }, [serviceDown]);

  const updateConnection = async (change: { enabled?: boolean; provider?: string }) => {
    if (connectionUpdating.current || !connection || serviceDown) return;
    connectionUpdating.current = true;
    setConnectionBusy(true);
    setConnectionError("");
    try {
      const next = await requestJSON<ConnectionView>("/connection", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      setConnection(next);
    } catch (error) {
      setConnectionError(errorText(error));
    } finally {
      connectionUpdating.current = false;
      setConnectionBusy(false);
    }
  };

  const filtered = items.filter((item) =>
    !query.trim() || item.conversationId.includes(query) || item.preview.includes(query)
  );

  return (
    <div className={`workspace-shell${listOpen ? " sessions-open" : ""}`}>
      <div className="chrome-top">
        <header className="app-bar">
          <div className="brand-mark"><img className="brand-logo" src="./icons/icon-48.png" alt="tChrome" /></div>
          <div className="app-identity">
            <strong>{session.conversationId ?? "tChrome"}</strong>
            <small>{compressing ? "正在压缩上下文" : running ? "正在处理" : statusText(session.status)}</small>
          </div>
          <div className="app-actions">
            <button className="icon-button" type="button" title="资料库" aria-label="资料库" aria-expanded={libraryOpen}
              onClick={() => { setListOpen(false); setLibraryOpen(true); }}>
              <Icon path="M5 3h14v18l-7-4-7 4V3z" />
            </button>
            <button className="icon-button" type="button" title="会话" onClick={() => setListOpen((open) => !open)}>
              <Icon path="M4 6h16M4 12h16M4 18h10" />
            </button>
            <button className="icon-button accent" type="button" title="新会话" onClick={() => void startNew()}>
              <Icon path="M12 5v14M5 12h14" />
            </button>
          </div>
        </header>
        {extensionIssue && !serviceDown ? <div className="status down" role="alert">{extensionIssue}</div> : null}
        {serviceDown || status ? <div className={`status ${serviceDown || status === DOWN ? "down" : ""}`}>{serviceDown ? DOWN : status}</div> : null}
        {syncError && !serviceDown ? <div className="status down" role="alert">会话状态同步失败，正在重试。{syncError}</div> : null}
        {listOpen && listError && !serviceDown ? <div className="status down" role="alert">会话列表更新失败。{listError}<button type="button" onClick={() => void loadAll()}>重试</button></div> : null}
        {compressing && !serviceDown ? <div className="status" role="status" aria-live="polite">{compressionText}，完成后自动继续。你也可以停止。</div> : null}
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
              <div className="welcome-mark"><img className="brand-logo" src="./icons/icon-128.png" alt="" /></div>
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
          {running && !compressing && !session.liveTool && session.messages.at(-1)?.role === "user" ? (
            <article className="message-row assistant muted">
              <Avatar who="assistant" />
              <div className="message-body"><div className="waiting-dots" role="status" aria-label="正在处理">
                <span aria-hidden="true">.</span><span aria-hidden="true">.</span><span aria-hidden="true">.</span>
              </div></div>
            </article>
          ) : null}
        </div>
        {showJump ? (
          <button className="jump-to-bottom" type="button" title="回到底部" aria-label="回到底部" onClick={() => scrollToBottom("smooth")}>
            <Icon path="M12 4v12M7 11l5 5 5-5M5 20h14" />
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
              if (shouldSubmitOnEnter(event)) {
                event.preventDefault();
                void sendText(draft.trim());
              }
            }}
            aria-label="输入消息"
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
                    title="删除会话"
                    aria-label={`删除会话：${item.preview || item.conversationId}`}
                    onClick={() => setPendingDelete({ conversationId: item.conversationId, preview: item.preview || item.conversationId })}
                  >
                    <Icon path="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="history-footer">
              {settingsOpen ? (
                <section className="settings-panel" id="connection-settings" aria-label="设置">
                  <strong>设置</strong>
        <div className="connection-settings" aria-busy={connectionBusy}>
          <label className="provider-picker">
            <span>模型</span>
            <select aria-label="模型服务商" value={connection?.provider ?? ""}
              disabled={connectionBusy || !connection || serviceDown}
              title="切换后从下一次模型请求生效，并自动保存"
              onChange={(event) => void updateConnection({ provider: event.target.value })}>
              {!connection && <option value="">连接中…</option>}
              {connection?.providers?.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label} · {provider.model}</option>
              ))}
            </select>
          </label>
          <div className="connection-setting-row"><span>连接方式</span>
          <button className="connection-switch" type="button" role="switch" aria-label="使用代理"
            disabled={connectionBusy || !connection || serviceDown} aria-checked={connection?.enabled === true}
            title={connection?.enabled ? "代理已开启，关闭后使用直连" : "当前使用直连，开启后使用代理"}
            onClick={() => void updateConnection({ enabled: !connection?.enabled })}>
            <span>{connection?.enabled ? "代理" : "直连"}</span>
            <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          </button>
          </div>
        </div>
        {connectionError && !serviceDown ? <div className="status down" role="alert">{connectionError}</div> : null}
                </section>
              ) : null}
              <button className={`icon-button${settingsOpen ? " accent" : ""}`} type="button"
                title="设置" aria-label="设置" aria-expanded={settingsOpen} aria-controls="connection-settings"
                onClick={() => setSettingsOpen((open) => !open)}>
                <Icon path="M9.5 3h5l.6 2.4 2.1 1.2 2.4-.7 2.5 4.2-1.8 1.7v2.4l1.8 1.7-2.5 4.2-2.4-.7-2.1 1.2-.6 2.4h-5l-.6-2.4-2.1-1.2-2.4.7-2.5-4.2 1.8-1.7v-2.4L1.9 10l2.5-4.2 2.4.7 2.1-1.2L9.5 3zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0" />
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {libraryOpen ? <LibraryPanel onClose={() => setLibraryOpen(false)} /> : null}
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
