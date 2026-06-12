import { describe, it, expect } from 'vitest';
import {
  Scope,
  SCOPE_PROFILES,
  SCOPE_PROFILE_NAMES,
  ALL_SCOPES,
  isScopeProfileName,
  scopeUriForShortName,
  expandScopeProfile,
} from '../../../src/auth/scopeProfiles.js';

describe('Scope enum', () => {
  it('every member resolves to its full OAuth URI (§9.2/§9.3)', () => {
    expect(Scope.GmailMetadata).toBe('https://www.googleapis.com/auth/gmail.metadata');
    expect(Scope.GmailReadonly).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(Scope.GmailModify).toBe('https://www.googleapis.com/auth/gmail.modify');
    expect(Scope.GmailCompose).toBe('https://www.googleapis.com/auth/gmail.compose');
    expect(Scope.GmailSend).toBe('https://www.googleapis.com/auth/gmail.send');
    expect(Scope.GmailLabels).toBe('https://www.googleapis.com/auth/gmail.labels');
    expect(Scope.MailGoogleCom).toBe('https://mail.google.com/');
  });

  it('ALL_SCOPES contains all 7 scopes', () => {
    expect(ALL_SCOPES).toHaveLength(7);
  });
});

describe('SCOPE_PROFILES expansion (§9.2)', () => {
  it('each profile expands to the exact full URI(s)', () => {
    expect(SCOPE_PROFILES.metadata).toEqual(['https://www.googleapis.com/auth/gmail.metadata']);
    expect(SCOPE_PROFILES.readonly).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(SCOPE_PROFILES.modify).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    expect(SCOPE_PROFILES.compose).toEqual(['https://www.googleapis.com/auth/gmail.compose']);
    expect(SCOPE_PROFILES.send).toEqual(['https://www.googleapis.com/auth/gmail.send']);
    expect(SCOPE_PROFILES.labels).toEqual(['https://www.googleapis.com/auth/gmail.labels']);
  });

  it('full is the sole exception → https://mail.google.com/', () => {
    expect(SCOPE_PROFILES.full).toEqual(['https://mail.google.com/']);
  });

  it('SCOPE_PROFILE_NAMES lists all 7 profiles', () => {
    expect(SCOPE_PROFILE_NAMES).toEqual([
      'metadata',
      'readonly',
      'modify',
      'compose',
      'send',
      'labels',
      'full',
    ]);
  });
});

describe('scopeUriForShortName', () => {
  it('maps short names to the auth URI and full to mail.google.com', () => {
    expect(scopeUriForShortName('gmail.readonly')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(scopeUriForShortName('full')).toBe('https://mail.google.com/');
    expect(scopeUriForShortName('https://mail.google.com/')).toBe('https://mail.google.com/');
  });
});

describe('expandScopeProfile / isScopeProfileName', () => {
  it('expands a valid profile name', () => {
    const r = expandScopeProfile('readonly');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  it('rejects an unknown profile with invalid_input', () => {
    const r = expandScopeProfile('superuser');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('isScopeProfileName guards correctly', () => {
    expect(isScopeProfileName('modify')).toBe(true);
    expect(isScopeProfileName('nope')).toBe(false);
  });
});
