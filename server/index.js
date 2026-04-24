import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import facebookRoutes from './routes/facebook.js';
import sheetsRoutes from './routes/sheets.js';
import ghlRoutes from './routes/ghl.js';
import chatRoutes from './routes/chat.js';
import reportsRoutes from './routes/reports.js';
import launcherRoutes from './routes/launcher.js';
import variationsRoutes from './routes/variations.js';
import hyrosRoutes from './routes/hyros.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
}));
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/facebook', facebookRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/ghl', ghlRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/launcher', launcherRoutes);
app.use('/api/variations', variationsRoutes);
app.use('/api/hyros', hyrosRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
