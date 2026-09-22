import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, ...args) {
  if (LEVELS[level] > current) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line, ...args);
}

export const log = {
  error: (...a) => emit('error', ...a),
  warn: (...a) => emit('warn', ...a),
  info: (...a) => emit('info', ...a),
  debug: (...a) => emit('debug', ...a),
};
