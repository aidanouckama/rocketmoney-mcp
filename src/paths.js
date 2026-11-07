import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { SafeError } from './errors.js';

export function defaultStateDirectory({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw new SafeError('UNSUPPORTED_PLATFORM', 'Supported platforms: macOS and Linux. Windows is not supported.');
  if (env.ROCKETMONEY_STATE_DIR) {
    if (!isAbsolute(env.ROCKETMONEY_STATE_DIR)) throw new SafeError('INVALID_CONFIG', 'ROCKETMONEY_STATE_DIR must be an absolute path.');
    return env.ROCKETMONEY_STATE_DIR;
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'rocketmoney-mcp-local');
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(base, 'rocketmoney-mcp-local');
}
