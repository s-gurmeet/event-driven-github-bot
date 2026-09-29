require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Proxy (needed on Render / behind reverse proxy) ───────────────────
app.set('trust proxy', 1);

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com', 'https://github.com'],
      connectSrc: ["'self'"],
    },
  },
}));

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500, // GitHub can send many webhooks
  skip: (req) => {
    // Only rate limit if no signature (signature check is stronger auth anyway)
    return !!req.headers['x-hub-signature-256'];
  },
});

// ─── Webhook route MUST be before body parsers (needs raw body) ───────────────
const webhooksRouter = require('./src/routes/webhooks');
app.use('/webhooks', webhookLimiter, webhooksRouter);

// ─── Body Parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ─── Session ──────────────────────────────────────────────────────────────────
const sessionConfig = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'bot.sid', // don't use default 'connect.sid'
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
};

if (process.env.NODE_ENV === 'production') {
  // Use database-backed sessions in production for persistence across restarts
  // Simple in-memory for now, can swap to connect-pg-simple
  console.log('[Server] Using cookie sessions (production mode)');
}

app.use(session(sessionConfig));

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRouter = require('./src/routes/auth');
const apiRouter = require('./src/routes/api');

app.use('/auth', authRouter);
app.use('/api', apiLimiter, apiRouter);

// ─── Page Routes ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: 'Database unavailable' });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // Validate required environment variables
    const required = ['DATABASE_URL', 'SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'APP_URL'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) {
      console.error(`[Server] Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Run database migration
    await db.migrate();
    console.log('[Server] Database ready');

    app.listen(PORT, () => {
      console.log(`[Server] GitHub Automation Bot running on port ${PORT}`);
      console.log(`[Server] App URL: ${process.env.APP_URL}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
