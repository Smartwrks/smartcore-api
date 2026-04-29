import express from 'express';

const router = express.Router();

// Public health check — used by Railway and uptime monitors.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'smartcore-api' });
});

export default router;
