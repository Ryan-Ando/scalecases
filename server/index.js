import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import facebookRoutes from './routes/facebook.js';
import sheetsRoutes from './routes/sheets.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
}));
app.use(express.json());

app.use('/api/facebook', facebookRoutes);
app.use('/api/sheets', sheetsRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
