import { describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { isAuthRequiredError } from './authError';

describe('isAuthRequiredError', () => {
  it('accepts ACP auth_required (-32000), from the SDK or a plain object', () => {
    expect(isAuthRequiredError(RequestError.authRequired())).toBe(true);
    expect(isAuthRequiredError(Object.assign(new Error('whatever'), { code: -32000 }))).toBe(true);
  });
  it('ignores message text, e.g. an MCP server asking for OAuth', () => {
    expect(isAuthRequiredError(new Error('OAuth required for MCP server github'))).toBe(false);
    expect(isAuthRequiredError(Object.assign(new Error('Authentication required'), { code: -32603 }))).toBe(false);
    expect(isAuthRequiredError({ message: 'auth required' })).toBe(false);
  });
  it('tolerates non-objects', () => {
    for (const value of [undefined, null, 'auth required', -32000]) { expect(isAuthRequiredError(value)).toBe(false); }
  });
});
