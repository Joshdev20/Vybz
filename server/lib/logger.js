const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, message };
  if (meta && Object.keys(meta).length) line.meta = redact(meta);
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

const SECRET_KEYS = /(password|token|secret|authorization|cookie|api_?key)/i;
function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

export const logger = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
};
