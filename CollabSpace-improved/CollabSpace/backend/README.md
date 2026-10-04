# CollabSpace Backend

Express + MySQL + `ws`. See the root README for the full guide.

```bash
npm install
cp .env.example .env     # set DB_PASSWORD
npm run db:init          # create DB + tables + sample data (safe to re-run)
npm run dev              # http://localhost:5000
```

Uploaded files are stored in `uploads/` and served at `/uploads/<file>`.
