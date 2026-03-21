import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import facebookRoutes from './routes/facebook.js';
import sheetsRoutes from './routes/sheets.js';
import ghlRoutes from './routes/ghl.js';
import chatRoutes from './routes/chat.js';
import reportsRoutes from './routes/reports.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
}));
app.use(express.json());

app.use('/api/facebook', facebookRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/ghl', ghlRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reports', reportsRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
