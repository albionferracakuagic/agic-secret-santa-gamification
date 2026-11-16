import { describe, expect, it } from 'vitest';
import { DB_PACKAGE } from './index.js';

describe('db', () => {
  it('exports package marker', () => {
    expect(DB_PACKAGE).toBe('@santa/db');
  });
});
