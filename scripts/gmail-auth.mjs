// Connexion unique de la boîte Gmail (Google Workspace) : affiche le jeton à mettre dans GMAIL_REFRESH_TOKEN.
// Prérequis : projet Google Cloud, API Gmail activée, écran de consentement « Interne », identifiant OAuth de type « Application de bureau ».
// Usage : GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… node scripts/gmail-auth.mjs   puis se connecter avec la boîte opérations.
import http from 'node:http';

const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error('Définissez GMAIL_CLIENT_ID et GMAIL_CLIENT_SECRET.'); process.exit(1); }
const PORT = 53682, redirect = `http://127.0.0.1:${PORT}/callback`;
// Lecture seule + envoi : l'outil ne supprime ni ne modifie jamais d'email
const scope = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'].join(' ');
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' })}`;

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('En attente…'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await r.json();
  res.end(j.refresh_token ? 'Connexion réussie : revenez au terminal.' : `Échec : ${j.error || r.status}`);
  console.log(j.refresh_token ? `\nAjoutez dans votre environnement :\nGMAIL_REFRESH_TOKEN=${j.refresh_token}\n` : `\nÉchec : ${JSON.stringify(j)}\n`);
  server.close();
});
server.listen(PORT, '127.0.0.1', () => console.log(`Ouvrez cette adresse et connectez-vous avec la boîte opérations :\n\n${url}\n`));
