import 'dotenv/config';   // first, so modules that read env at import see .env values
import express from 'express';
import cors from 'cors';
import authRoutes, { requireLogin } from './routes/auth.js';
import facebookRoutes from './routes/facebook.js';
import stateRoutes from './routes/state.js';
import { NICHE, isLaw } from './niche.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  exposedHeaders: ['X-Stale-Minutes', 'X-FB-Failed-Accounts'],
}));
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

app.use('/api', requireLogin);
app.use('/api/auth', authRoutes);
app.use('/api/facebook', facebookRoutes);
app.use('/api/state', stateRoutes);

// The law site's integrations. The insurance niche servers never load these modules: some act
// on import (digest.js claims the Telegram bot's webhook), and none apply to those accounts.
let startSchedules = () => {};
if (isLaw) {
  const [sheets, ghl, chat, reports, launcher, variations, hyros, snapshots, digest, admanage] = await Promise.all([
    import('./routes/sheets.js'), import('./routes/ghl.js'), import('./routes/chat.js'), import('./routes/reports.js'),
    import('./routes/launcher.js'), import('./routes/variations.js'), import('./routes/hyros.js'),
    import('./routes/snapshots.js'), import('./routes/digest.js'), import('./routes/admanage.js'),
  ]);
  app.use('/api/sheets', sheets.default);
  app.use('/api/ghl', ghl.default);
  app.use('/api/chat', chat.default);
  app.use('/api/reports', reports.default);
  app.use('/api/launcher', launcher.default);
  app.use('/api/variations', variations.default);
  app.use('/api/hyros', hyros.default);
  app.use('/api/snapshots', snapshots.default);
  app.use('/api/digest', digest.default);
  app.use('/api/admanage', admanage.default);
  startSchedules = () => { sheets.startSpendSchedule(); digest.startCampaignCplSchedule(); };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', niche: NICHE }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (${NICHE})`);
  startSchedules();
});
