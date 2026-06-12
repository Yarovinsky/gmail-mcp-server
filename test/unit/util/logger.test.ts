import { describe, it, expect } from 'vitest';
import { createLogger } from '../../../src/util/logger.js';

/** Collect pino's NDJSON output lines into a string buffer. */
function collector(): { write: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return {
    write: (s: string) => {
      lines.push(s);
    },
    text: () => lines.join(''),
  };
}

describe('createLogger token redaction', () => {
  it('never emits a token from the merge object or the message (regardless of flag)', () => {
    const sink = collector();
    const logger = createLogger({ level: 'info', destination: sink });

    logger.info(
      {
        access_token: 'ya29.TOPSECRET',
        refresh_token: '1//0gREFRESHsecret',
        pageToken: 'safe-123',
      },
      'message containing ya29.TOPSECRET inline',
    );

    const out = sink.text();
    expect(out).not.toContain('ya29.TOPSECRET');
    expect(out).not.toContain('1//0gREFRESHsecret');
    expect(out).toContain('[REDACTED]');
    // Non-sensitive pagination token survives.
    expect(out).toContain('safe-123');
  });

  it('scrubs tokens inside logged Error objects but still logs the error', () => {
    const sink = collector();
    const logger = createLogger({ level: 'error', destination: sink });

    logger.error(new Error('boom ya29.LEAKED'), 'request failed');

    const out = sink.text();
    expect(out).not.toContain('ya29.LEAKED');
    expect(out).toContain('request failed');
  });

  it('honors the configured level (silent emits nothing)', () => {
    const sink = collector();
    const logger = createLogger({ level: 'silent', destination: sink });
    logger.info('should not appear');
    logger.error('should not appear either');
    expect(sink.text()).toBe('');
  });
});
