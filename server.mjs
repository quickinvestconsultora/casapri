import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iniciarDb } from './src/db.mjs';
import { rutasApi } from './src/api.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const publico = path.join(dir, 'public');

await iniciarDb();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use('/api', rutasApi());
app.use(express.static(publico, { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(publico, '404.html')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Casapri escuchando en http://localhost:${port}`));
