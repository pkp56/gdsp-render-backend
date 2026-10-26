# Backend GDSP — International Series Lola T290

API Node.js/Express et base PostgreSQL persistante pour les classements et pénalités GDSP.

## Déploiement Render (recommandé)

1. Dépose le contenu de ce dossier dans un dépôt GitHub.
2. Dans Render, choisis **New → Blueprint** et sélectionne ce dépôt (le fichier `render.yaml` configure l'API et PostgreSQL).
3. Renseigne les variables demandées :
   - `ADMIN_USERNAME` : identifiant administrateur souhaité.
   - `ADMIN_PASSWORD` : mot de passe unique et long. Ne réutilise pas `admin/demo`.
   - `FRONTEND_ORIGIN` : URL exacte du site frontend, par exemple `https://mon-site.onrender.com`. Pour plusieurs origines, sépare-les par des virgules.
4. Déploie. Render créera l'API `gdsp-lola-t290-api` et la base PostgreSQL. La base de données est la sauvegarde persistante ; elle n'est pas le disque éphémère du service web.
5. Vérifie `https://NOM-DU-SERVICE.onrender.com/health`. La réponse doit contenir `{"ok":true,"database":"connected"}`.

Le plan de base de données du Blueprint peut être payant selon les tarifs et disponibilités Render. Vérifie les coûts affichés avant de confirmer.

## Relier le site GDSP

Dans le `index.html` du frontend, remplace la constante :

```js
const GDSP_API_URL='https://REMPLACER-PAR-LE-SERVICE-BACKEND.onrender.com';
```

par l'URL réelle de ton service Render, sans barre oblique finale. Publie ensuite le frontend.

## Fonctionnement

- `GET /api/results` : lecture publique des derniers résultats et pénalités.
- `POST /api/auth/login` : connexion administrateur ; retourne un jeton valable 8 heures.
- `PUT /api/results` : sauvegarde des résultats et pénalités, authentification Bearer obligatoire.
- `GET /health` : contrôle de santé de l'API et de PostgreSQL.

Le frontend conserve aussi une copie locale de secours. Une modification est envoyée à PostgreSQL quand l'administrateur est connecté au backend. Le jeton reste en `sessionStorage` jusqu'à la fermeture de la session du navigateur.

## Développement local

```bash
npm install
cp .env.example .env
# renseigne DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD et JWT_SECRET
npm start
```

Le service écoute sur `PORT` (10000 par défaut). Pour une base PostgreSQL locale, utilise son URL de connexion dans `DATABASE_URL`.

## Sécurité

- Configure un mot de passe fort et une valeur aléatoire longue pour `JWT_SECRET`.
- Ne mets jamais de secret de serveur dans le JavaScript public du frontend.
- L'API publique expose les résultats, mais seules les requêtes munies d'un jeton administrateur peuvent les modifier.
- Configure `FRONTEND_ORIGIN` avec l'origine réelle du site pour limiter les appels navigateur.
- Le prototype conserve un jeu de données initial de démonstration ; importe les résultats officiels dans l'interface d'administration puis connecte-toi pour les sauvegarder sur le serveur.
