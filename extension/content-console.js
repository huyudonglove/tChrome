(() => {
  if (globalThis.__telanceConsole) return;
  const buf = [];
  const push = (level, args) => {
    const text = args.map((item) => {
      try {
        return typeof item === 'string' ? item : JSON.stringify(item);
      } catch {
        return String(item);
      }
    }).join(' ').slice(0, 500);
    buf.push({level, text, t: Date.now()});
    if (buf.length > 200) buf.shift();
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      push(level, args);
      orig(...args);
    };
  }
  globalThis.addEventListener('error', (event) => {
    push('error', [event.message, event.filename, event.lineno]);
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    push('error', [String(event.reason)]);
  });
  globalThis.__telanceConsole = buf;
})();
