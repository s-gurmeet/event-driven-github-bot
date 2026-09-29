const crypto = require('crypto');

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  try {
    // bufferEqual uses constant-time comparison
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    // Lengths differ — definitely invalid
    return false;
  }
}

/**
 * Express middleware to verify webhook signature.
 * Requires the raw body buffer to be available.
 */
function webhookSignatureMiddleware(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const deliveryId = req.headers['x-github-delivery'];
  const eventType = req.headers['x-github-event'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }
  if (!deliveryId) {
    return res.status(400).json({ error: 'Missing delivery ID' });
  }

  // Signature verification happens in the route handler (needs repo-specific secret)
  req.webhookDeliveryId = deliveryId;
  req.webhookEventType = eventType;
  req.webhookRawBody = req.rawBody;
  req.webhookSignature = signature;

  next();
}

module.exports = { verifyWebhookSignature, webhookSignatureMiddleware };
