const express = require('express');
const db = require('../db');
const { verifyWebhookSignature, webhookSignatureMiddleware } = require('../middleware/webhook');
const rules = require('../services/rules');

const router = express.Router();

// Capture raw body for signature verification BEFORE any JSON parsing
router.use((req, res, next) => {
  let raw = [];
  req.on('data', chunk => raw.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(raw);
    next();
  });
});

/**
 * Main webhook endpoint.
 * URL format: /webhooks/github/:repoId
 * Each repository gets its own endpoint URL with a unique HMAC secret.
 */
router.post('/github/:repoId', webhookSignatureMiddleware, async (req, res) => {
  const { repoId } = req.params;
  const deliveryId = req.webhookDeliveryId;
  const eventType = req.webhookEventType;
  const rawBody = req.webhookRawBody;
  const signature = req.webhookSignature;

  // Acknowledge immediately — GitHub requires a fast response
  res.status(200).json({ ok: true, deliveryId });

  // Process asynchronously to avoid timeout
  setImmediate(async () => {
    try {
      await processWebhook({ repoId, deliveryId, eventType, signature, rawBody });
    } catch (err) {
      console.error(`[Webhook] Processing error for delivery ${deliveryId}:`, err.message);
    }
  });
});

async function processWebhook({ repoId, deliveryId, eventType, signature, rawBody }) {
  // Load repository and verify it exists
  const repoResult = await db.query(
    `SELECT r.*, u.access_token FROM repositories r
     JOIN users u ON u.id = r.user_id
     WHERE r.id = $1 AND r.active = TRUE`,
    [repoId]
  );

  if (!repoResult.rows.length) {
    console.warn(`[Webhook] Unknown or inactive repo ID: ${repoId}`);
    return;
  }

  const repo = repoResult.rows[0];

  // Verify HMAC signature using repo-specific secret
  if (!verifyWebhookSignature(rawBody, signature, repo.webhook_secret)) {
    console.warn(`[Webhook] Invalid signature for repo ${repo.full_name}, delivery ${deliveryId}`);
    return;
  }

  // Parse payload now that signature is verified
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error(`[Webhook] Invalid JSON payload for delivery ${deliveryId}`);
    return;
  }

  const action = payload.action || null;

  // Idempotency check: skip if we've already processed this delivery
  const existingEvent = await db.query(
    'SELECT id, processed FROM events WHERE delivery_id = $1',
    [deliveryId]
  );

  if (existingEvent.rows.length > 0) {
    const existing = existingEvent.rows[0];
    if (existing.processed) {
      console.info(`[Webhook] Duplicate delivery ${deliveryId} (already processed), skipping`);
      return;
    }
    // Exists but not processed — process it now
    await runEventProcessing(existingEvent.rows[0].id, repo, payload, eventType, action);
    return;
  }

  // Store the event first (processed = false for durability)
  const eventInsert = await db.query(
    `INSERT INTO events (delivery_id, repo_id, event_type, action, payload, processed)
     VALUES ($1, $2, $3, $4, $5, FALSE)
     RETURNING id`,
    [deliveryId, repoId, eventType, action, JSON.stringify(payload)]
  );

  const eventId = eventInsert.rows[0].id;
  console.log(`[Webhook] Stored event ${eventId} (${eventType}:${action || 'n/a'}) for ${repo.full_name}`);

  await runEventProcessing(eventId, repo, payload, eventType, action);
}

async function runEventProcessing(eventId, repo, payload, eventType, action) {
  // Build a minimal event object for the rules engine
  const event = {
    id: eventId,
    repo_id: repo.id,
    event_type: eventType,
    action,
    payload,
  };

  try {
    const actionResults = await rules.processRules(event, repo);
    console.log(`[Webhook] Event ${eventId} processed: ${actionResults.length} action(s)`);

    // Mark event as processed
    await db.query(
      `UPDATE events SET processed = TRUE, processed_at = NOW() WHERE id = $1`,
      [eventId]
    );
  } catch (err) {
    // Record error but mark as processed to avoid infinite retry loops
    await db.query(
      `UPDATE events
       SET processed = TRUE, processing_error = $1, processed_at = NOW()
       WHERE id = $2`,
      [err.message, eventId]
    );
    throw err;
  }
}

module.exports = router;
