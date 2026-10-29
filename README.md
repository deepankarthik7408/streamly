# Streamly – Netflix-style catalog app (Express + MySQL)

Browse, search and filter the Netflix titles dataset. Note: the dataset has no video or poster files,
so the app is a catalog (the "Trailer" button opens a YouTube search). Optional TMDB key adds real posters.

## 1. Free MySQL on Aiven
1. Sign up at https://aiven.io → Create service → MySQL → choose the **Free** plan.
2. Wait until it is *Running*. Copy Host, Port, User (avnadmin), Password.
3. Import the data (needs the `mysql` client installed locally):
   ```
   mysql -h HOST -P PORT -u avnadmin -p --ssl-mode=REQUIRED --default-character-set=utf8mb4 < db/netflix.sql
   ```
   This creates a database called `netflix`.
4. Connection string for the app:
   `mysql://avnadmin:PASSWORD@HOST:PORT/defaultdb`  (and set `DB_NAME=netflix`)

## 2. Run locally
```
npm install
cp .env.example .env     # edit DATABASE_URL
npm run dev              # http://localhost:3000
```

## 3. Deploy free on Render
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → pick the repo. Runtime: Node. Build: `npm install`. Start: `npm start`. Plan: Free.
3. Environment variables: `DATABASE_URL`, `DB_NAME=netflix`, and optionally `TMDB_API_KEY`.
4. Deploy. Free services sleep when idle, so the first visit after a break takes ~30-60 s.

## API
`GET /api/titles?type=&genre=&country=&year=&q=&sort=new|year|az&page=&limit=` ·
`/api/titles/:id` · `/api/rows` · `/api/featured` · `/api/filters` · `/api/poster`
