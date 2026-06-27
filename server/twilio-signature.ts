import twilio from 'twilio';

export function validateTwilioSignature(opts: {
  authToken: string;
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!opts.signature) return false;
  return twilio.validateRequest(opts.authToken, opts.signature, opts.url, opts.params);
}
