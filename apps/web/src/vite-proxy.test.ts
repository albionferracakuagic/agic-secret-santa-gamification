import { describe, expect, it } from 'vitest';
import type { ProxyOptions, UserConfig } from 'vite';
import config from '../vite.config';

describe('Vite tunnel proxy', () => {
  it('preserves the browser host and forwards trusted protocol/host/client metadata', () => {
    const proxy = (config as UserConfig).server?.proxy as Record<string, string | ProxyOptions>;
    for (const path of ['/api', '/media', '/health', '/socket.io']) {
      const options = proxy[path] as ProxyOptions;
      expect(options.target).toBe('http://localhost:3000');
      expect(options.changeOrigin).toBe(false);
      expect(options.xfwd).toBe(true);
    }
    expect((proxy['/socket.io'] as ProxyOptions).ws).toBe(true);
  });
});
