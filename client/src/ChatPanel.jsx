import { useState, useRef, useEffect } from 'react';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function ChatPanel({ context }) {
  const [open, setOpen]       = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');

    const userMsg = { role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setLoading(true);

    // Add empty assistant message to stream into
    const assistantIdx = next.length;
    setMessages(m => [...m, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map(m => ({ role: m.role, content: m.content })),
          context,
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = JSON.parse(line.slice(6));
          if (payload.error) throw new Error(payload.error);
          if (payload.done) break;
          if (payload.text) {
            setMessages(m => {
              const copy = [...m];
              copy[assistantIdx] = { ...copy[assistantIdx], content: copy[assistantIdx].content + payload.text };
              return copy;
            });
          }
        }
      }
    } catch (err) {
      setMessages(m => {
        const copy = [...m];
        copy[assistantIdx] = { role: 'assistant', content: `Error: ${err.message}`, error: true };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
          width: 52, height: 52, borderRadius: '50%', border: 'none',
          background: 'var(--green)', color: '#fff', fontSize: 22,
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'transform 0.15s',
        }}
        title="Ask AI"
      >
        {open ? '✕' : '✦'}
      </button>

      {/* Panel */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 1000,
          width: 380, height: 520, display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 16 }}>✦</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>AI Assistant</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ask about your ad performance</div>
            </div>
            {messages.length > 0 && (
              <button
                className="btn btn--sm"
                onClick={() => setMessages([])}
                style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 24 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>✦</div>
                <div>Ask me anything about your ads.</div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    'Which state has the lowest CPL?',
                    'What\'s my total spend this month?',
                    'Which ads are performing best?',
                  ].map(q => (
                    <button
                      key={q}
                      className="btn btn--sm"
                      onClick={() => { setInput(q); inputRef.current?.focus(); }}
                      style={{ fontSize: 11, textAlign: 'left' }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '88%',
              }}>
                <div style={{
                  padding: '8px 12px', borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                  background: m.role === 'user' ? 'var(--green)' : m.error ? '#fee2e2' : 'var(--bg)',
                  color: m.role === 'user' ? '#fff' : m.error ? '#dc2626' : 'var(--text)',
                  fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  border: m.role === 'assistant' ? '1px solid var(--border)' : 'none',
                }}>
                  {m.content || (loading && i === messages.length - 1 ? '…' : '')}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about performance, trends, CPL…"
              rows={1}
              disabled={loading}
              style={{
                flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 8,
                padding: '8px 10px', fontSize: 13, background: 'var(--bg)', color: 'var(--text)',
                fontFamily: 'inherit', outline: 'none', lineHeight: 1.4,
              }}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="btn btn--primary"
              style={{ padding: '0 14px', borderRadius: 8, fontSize: 16 }}
            >
              ↑
            </button>
          </div>
        </div>
      )}
    </>
  );
}
