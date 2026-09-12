import { useEffect, useRef, useState } from "react";
import { errorText, requestJSON } from "./service";

type Kind = "website" | "account" | "note";
type Item = { id: string; type: Kind; title: string; url: string; username: string; password: string; content: string; tags: string[]; createdAt: string; updatedAt: string };
type Draft = Omit<Item, "id" | "createdAt" | "updatedAt" | "tags"> & { id?: string; tags: string };
const labels: Record<Kind, string> = { website: "网站", account: "账号", note: "资料" };
const emptyDraft = (): Draft => ({ type: "website", title: "", url: "", username: "", password: "", content: "", tags: "" });
const safeURL = (value: string) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
const Icon = ({ name }: { name: "close" | "copy" | "delete" | "edit" }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={{ close: "M6 6l12 12M18 6L6 18", copy: "M9 9h11v11H9zM15 9V4H4v11h5", delete: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7", edit: "M15 4l5 5M4 20l5-1L21 7l-4-4L5 15z" }[name]} /></svg>;

export function LibraryPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const lock = useRef(false);
  const sequence = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  async function refresh() {
    const seq = ++sequence.current;
    try {
      const result = await requestJSON<{ items: Item[] }>(`/library?q=${encodeURIComponent(queryRef.current)}`);
      if (mounted.current && seq === sequence.current) setItems(result.items);
    } catch (e) { if (mounted.current && seq === sequence.current) setError(errorText(e)); }
    finally { if (mounted.current && seq === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => { if (!lock.current) void refresh(); }, 3000);
    return () => { mounted.current = false; sequence.current++; clearInterval(timer); };
  }, []);
  useEffect(() => { const timer = setTimeout(() => void refresh(), 180); return () => { clearTimeout(timer); sequence.current++; }; }, [query]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2500); return () => clearTimeout(timer); }, [notice]);

  async function mutate(path: string, body: unknown, done: () => void) {
    if (lock.current) return;
    lock.current = true;
    sequence.current++;
    setBusy(true); setError("");
    try {
      await requestJSON(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (mounted.current) { done(); await refresh(); }
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("已复制"); } catch { setError("复制失败，请选中文字手动复制。"); }
  }
  function edit(item: Item) {
    setError(""); setDraft({ id: item.id, type: item.type, title: item.title, url: item.url, username: item.username, password: item.password, content: item.content, tags: item.tags.join(", ") });
  }
  const visible = items.filter(item => filter === "all" || item.type === filter);
  const field = (label: string, value: string) => value ? <div className="library-field"><span>{label}</span><div><span>{value}</span><button type="button" className="library-icon" title={`复制${label}`} aria-label={`复制${label}`} onClick={() => void copy(value)}><Icon name="copy" /></button></div></div> : null;
  return <section className="library-panel" aria-label="本地资料库">
    <header className="library-header"><div><strong>资料库</strong><small>本机保存 · 跨会话使用</small></div><button type="button" className="library-icon" aria-label="关闭资料库" title="关闭资料库" disabled={busy} onClick={onClose}><Icon name="close" /></button></header>
    <div className="library-toolbar"><input aria-label="搜索资料" placeholder="搜索名称、内容或标签" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" className="library-primary" disabled={busy || !!draft} onClick={() => { setDraft(emptyDraft()); setError(""); }}>新增</button></div>
    <div className="library-filters" aria-label="资料类型">{(["all", "website", "account", "note"] as const).map(kind => <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === "all" ? "全部" : labels[kind]}</button>)}</div>
    {error && <div className="library-error" role="alert">{error}<button type="button" onClick={() => setError("")}>关闭</button></div>}
    {notice && <div className="library-notice" role="status">{notice}</div>}
    <div className="library-scroll">
      {draft ? <form className="library-editor" onSubmit={e => {
        e.preventDefault();
        if (!draft.title.trim()) { setError("请填写名称。"); return; }
        if (draft.url && !safeURL(draft.url)) { setError("网址需要是完整的 http 或 https 链接。"); return; }
        void mutate("/library/save", { ...draft, title: draft.title.trim(), tags: [...new Set(draft.tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))] }, () => { setDraft(null); setNotice("已保存"); });
      }}>
        <h2>{draft.id ? "编辑资料" : "新增资料"}</h2>
        <label>类型<select disabled={busy} value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as Kind })}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>名称<input required disabled={busy} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>网址<input disabled={busy} inputMode="url" placeholder="https://" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label>
        {(draft.type === "account" || draft.username || draft.password) && <><label>账号<input disabled={busy} autoComplete="off" value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} /></label><label>密码<input type="text" disabled={busy} autoComplete="off" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} /></label></>}
        <label>内容 / 备注<textarea rows={5} disabled={busy} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} /></label>
        <label>标签<input disabled={busy} placeholder="用逗号分隔" value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} /></label>
        <div className="library-editor-actions"><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="library-primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存"}</button></div>
      </form> : <>
        <p className="library-count">{loading ? "正在读取…" : `${visible.length} 条资料`}</p>
        {!loading && !visible.length && <div className="library-empty">{query || filter !== "all" ? "没有找到匹配的资料" : "把常用网站、账号和有用的信息留在这里。也可以直接让 Agent 帮你保存。"}</div>}
        {visible.map(item => <article className="library-card" key={item.id}>
          <div className="library-card-title"><div><span className="library-kind">{labels[item.type]}</span><h2>{item.title}</h2></div><div className="library-card-actions"><button type="button" className="library-icon" disabled={busy} title="编辑资料" aria-label={`编辑 ${item.title}`} onClick={() => edit(item)}><Icon name="edit" /></button><button type="button" className="library-icon library-delete" disabled={busy} title="删除资料" aria-label={`删除 ${item.title}`} onClick={() => void mutate("/library/delete", { id: item.id }, () => setNotice("已删除"))}><Icon name="delete" /></button></div></div>
          {item.url && <div className="library-field"><span>网址</span><div>{safeURL(item.url) ? <a href={safeURL(item.url)!} target="_blank" rel="noopener noreferrer">{item.url}</a> : <span>{item.url}</span>}<button type="button" className="library-icon" title="复制网址" aria-label="复制网址" onClick={() => void copy(item.url)}><Icon name="copy" /></button></div></div>}
          {field("账号", item.username)}{field("密码", item.password)}{field("内容", item.content)}
          {item.tags.length > 0 && <div className="library-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
        </article>)}
      </>}
    </div>
  </section>;
}
