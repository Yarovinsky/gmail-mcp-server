import { describe, it, expect } from 'vitest';
import {
  confirmationRequired,
  checkConfirmation,
  CONFIRMATION_STRINGS,
  type ConfirmationContext,
} from '../../../src/safety/confirmation.js';

const BOTH_OFF: ConfirmationContext = {
  requireConfirmationForSend: false,
  requireConfirmationForModify: false,
};
const BOTH_ON: ConfirmationContext = {
  requireConfirmationForSend: true,
  requireConfirmationForModify: true,
};

describe('confirmationRequired (§16.3)', () => {
  it('trash always requires confirmation, even with both flags off (§12.15)', () => {
    expect(confirmationRequired('trash', BOTH_OFF)).toBe(true);
    expect(confirmationRequired('trash', BOTH_ON)).toBe(true);
  });

  it('send requires confirmation only when requireConfirmationForSend', () => {
    expect(confirmationRequired('send', BOTH_OFF)).toBe(false);
    expect(confirmationRequired('send', { ...BOTH_OFF, requireConfirmationForSend: true })).toBe(
      true,
    );
  });

  it('modify requires confirmation when the flag is on', () => {
    expect(
      confirmationRequired('modify', { ...BOTH_OFF, requireConfirmationForModify: true }),
    ).toBe(true);
    expect(confirmationRequired('modify', { ...BOTH_OFF, messageCount: 1 })).toBe(false);
  });

  it('modify on multiple messages requires confirmation even if the flag is off (§12.14)', () => {
    expect(confirmationRequired('modify', { ...BOTH_OFF, messageCount: 2 })).toBe(true);
  });
});

describe('checkConfirmation (§16.3)', () => {
  it('proceeds when confirmation is not required, regardless of input', () => {
    expect(checkConfirmation('send', undefined, BOTH_OFF).ok).toBe(true);
    expect(checkConfirmation('modify', 'whatever', { ...BOTH_OFF, messageCount: 1 }).ok).toBe(true);
  });

  it('rejects a missing confirmation when required', () => {
    const out = checkConfirmation('trash', undefined, BOTH_OFF);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('confirmation_required');
      expect(out.error.details).toMatchObject({
        action: 'trash',
        expectedConfirmation: CONFIRMATION_STRINGS.trash,
      });
    }
  });

  it('rejects an incorrect confirmation string', () => {
    const out = checkConfirmation('send', 'yes please', {
      ...BOTH_OFF,
      requireConfirmationForSend: true,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('confirmation_required');
  });

  it('is case-sensitive', () => {
    const lower = CONFIRMATION_STRINGS.trash.toLowerCase();
    const out = checkConfirmation('trash', lower, BOTH_OFF);
    expect(out.ok).toBe(false);
  });

  it('proceeds on the exact confirmation string', () => {
    expect(checkConfirmation('trash', CONFIRMATION_STRINGS.trash, BOTH_OFF).ok).toBe(true);
    expect(
      checkConfirmation('send', CONFIRMATION_STRINGS.send, {
        ...BOTH_OFF,
        requireConfirmationForSend: true,
      }).ok,
    ).toBe(true);
  });

  it('requires confirmation for a multi-message modify with the flag off (§12.14)', () => {
    const ctx = { ...BOTH_OFF, messageCount: 3 };
    expect(checkConfirmation('modify', undefined, ctx).ok).toBe(false);
    expect(checkConfirmation('modify', CONFIRMATION_STRINGS.modify, ctx).ok).toBe(true);
  });
});
