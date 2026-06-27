import { describe, it, expect } from 'vitest';
import { validateTwilioSignature } from '../server/twilio-signature';
import twilio from 'twilio';

// Build a real valid signature using the SDK's own algorithm, then assert our
// wrapper accepts it and rejects tampering.
const authToken = 'test_token_123';
const url = 'https://x.test/voice/incoming';
const params = { CallSid: 'CA1', From: '+15551234567' };
const goodSig = twilio.getExpectedTwilioSignature(authToken, url, params);

describe('validateTwilioSignature', () => {
  it('accepts a correct signature', () => {
    expect(validateTwilioSignature({ authToken, signature: goodSig, url, params })).toBe(true);
  });
  it('rejects a wrong signature', () => {
    expect(validateTwilioSignature({ authToken, signature: 'wrong', url, params })).toBe(false);
  });
  it('rejects a missing signature', () => {
    expect(validateTwilioSignature({ authToken, signature: undefined, url, params })).toBe(false);
  });
  it('rejects when params are tampered', () => {
    expect(validateTwilioSignature({ authToken, signature: goodSig, url,
      params: { ...params, From: '+19998887777' } })).toBe(false);
  });
});
