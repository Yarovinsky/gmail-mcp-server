import { describe, it, expect } from 'vitest';
import { REQUIRED_SCOPES, checkScopes, scopeGateFor } from '../../../src/auth/scopeGate.js';
import { Scope } from '../../../src/auth/scopeProfiles.js';
import { composeGates, featureGate, type AnyTool } from '../../../src/mcp/toolRegistry.js';
import { defaultConfig, ConfigSchema } from '../../../src/config/configSchema.js';

describe('REQUIRED_SCOPES', () => {
  it('maps all 17 §12 tools', () => {
    expect(Object.keys(REQUIRED_SCOPES)).toHaveLength(17);
    expect(REQUIRED_SCOPES.gmail_send_message).toEqual([Scope.GmailSend, Scope.MailGoogleCom]);
    expect(REQUIRED_SCOPES.gmail_get_message).toContain(Scope.GmailReadonly);
  });
});

describe('checkScopes (§9.3 any-of)', () => {
  it('allows when granted contains one of the required scopes', () => {
    const result = checkScopes(REQUIRED_SCOPES.gmail_search_messages, [Scope.GmailReadonly]);
    expect(result).toBeNull();
  });

  it('blocks with insufficient_scope + requiredAnyOf/granted when none match', () => {
    const granted = [Scope.GmailSend];
    const error = checkScopes(REQUIRED_SCOPES.gmail_get_message, granted);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('insufficient_scope');
    expect(error?.details).toEqual({
      requiredAnyOf: [...REQUIRED_SCOPES.gmail_get_message],
      granted,
    });
  });

  it('allows when no scope is required', () => {
    expect(checkScopes(undefined, [])).toBeNull();
    expect(checkScopes([], [Scope.GmailReadonly])).toBeNull();
  });
});

describe('scopeGateFor', () => {
  it('produces a gate keyed on a tool’s requiredScopesAnyOf', () => {
    const gate = scopeGateFor([Scope.GmailReadonly]);
    expect(gate({ requiredScopesAnyOf: [Scope.GmailReadonly] })).toBeNull();
    expect(gate({ requiredScopesAnyOf: [Scope.GmailSend] })?.code).toBe('insufficient_scope');
    expect(gate({})).toBeNull();
  });
});

describe('feature vs scope precedence (composed gate)', () => {
  function fakeTool(feature: AnyTool['feature'], scopes: readonly string[]): AnyTool {
    return {
      name: 'fake',
      description: 'fake',
      inputSchema: ConfigSchema, // any zod object; unused by the gate
      feature,
      requiredScopesAnyOf: scopes,
      handler: () => ({ ok: true }),
    } as unknown as AnyTool;
  }

  it('returns feature_disabled (not insufficient_scope) when the feature is off', () => {
    // drafts is off by default; the tool also lacks the required scope.
    const gate = composeGates(featureGate(defaultConfig()), scopeGateFor([Scope.GmailSend]));
    const error = gate(fakeTool('drafts', [Scope.GmailCompose]));
    expect(error?.code).toBe('feature_disabled');
  });

  it('returns insufficient_scope when the feature is on but the scope is missing', () => {
    const config = ConfigSchema.parse({ features: { drafts: true } });
    const gate = composeGates(featureGate(config), scopeGateFor([Scope.GmailSend]));
    const error = gate(fakeTool('drafts', [Scope.GmailCompose]));
    expect(error?.code).toBe('insufficient_scope');
  });
});
