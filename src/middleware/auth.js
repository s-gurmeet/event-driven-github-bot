/**
 * Middleware to require an authenticated session.
 * Returns 401 for API routes, redirects for page routes.
 */
function requireAuth(req, res, next) {
  if (req.session?.userId) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Store intended destination for post-login redirect
  req.session.returnTo = req.originalUrl;
  return res.redirect('/');
}

module.exports = { requireAuth };
