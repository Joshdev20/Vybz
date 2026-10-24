/** WebSocket client with exponential backoff reconnect and typed handlers. */
import { setState, store } from './state.js';

const handlers = new Map();
let socket = null;
let attempt = 0;
let heartbeat = null;
let manualClose = false;

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

function emit(type, payload) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[realtime] handler error', type, err);
    }
  }
}

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  manualClose = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    attempt = 0;
    setState({ connection: 'online' });
    emit('connection', { state: 'online' });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send('ping', {}), 25000);
  };

  socket.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    emit(msg.type, msg.payload);
    emit('*', msg);
  };

  socket.onclose = () => {
    clearInterval(heartbeat);
    setState({ connection: 'offline' });
    emit('connection', { state: 'offline' });
    if (!manualClose) scheduleReconnect();
  };

  socket.onerror = () => {
    setState({ connection: 'offline' });
  };
}

function scheduleReconnect() {
  attempt += 1;
  const delay = Math.min(15000, 700 * 2 ** Math.min(attempt, 5));
  setState({ connection: 'reconnecting' });
  setTimeout(() => connect(), delay);
}

export function disconnect() {
  manualClose = true;
  clearInterval(heartbeat);
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  socket = null;
}

export function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ type, ...payload }));
    return true;
  } catch {
    return false;
  }
}

export function isConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

export function connectionState() {
  return store.connection;
}
