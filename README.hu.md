# report-engine

[English](README.md)

Havi weboldal-riport egy webügynökség üzemeltetési csomagos ügyfeleinek. Naponta gyűjt adatot (Search Console, Cloudflare Web Analytics, elérhetőség, munkanapló) SQLite-ba, havonta HTML-riportot tesz R2-re, és email-összefoglalót küld. Az ügyfélhez csak jóváhagyás után megy ki.

## Működés

```
naponta      uptime (5 percenként), collect, backup
hó 4-én      collect-monthly, report --live   → draft + előnézet emailben
kézzel       approve, send                    → R2-feltöltés + email az ügyfélnek
```

Az AI-szöveg csak `report --live`-val készül. A modell nem írhat le olyan számot, ami nincs a bemenetben. Ha mégis megteszi, egyszer újrapróbálja, utána a riport AI-szöveg nélkül készül el.

## Indítás

```
cp .env.example .env
cp config/clients/example.yaml config/clients/<id>.yaml
npm ci                     # Node 24
npm run cli -- status
npm run typecheck && npm test
```

Konténerben: `docker compose up -d scheduler`, egyszeri parancs: `docker compose run --rm cli <parancs>`.

Parancsok: `status`, `collect`, `collect-monthly`, `uptime`, `backfill`, `log`, `report`, `approve`, `send`, `backup`, `restore`.

## Konfiguráció

- `config/clients/<id>.yaml`: ügyfelenként egy fájl, minta az `example.yaml`.
- `config/prompts/*.md`: saját promptok, fájlonként felülírják a `src/report/prompts/` általános változatát.
- `BRAND_NAME`: az ügynökség neve a riportban és az emailben (opcionális).
- Titkok: env vagy `secrets/`, lásd `.env.example`.

A `config/` (az `example.yaml` kivételével) és a `secrets/` nincs a repóban és az image-ben sem.

## Éles üzem

Docker Compose a VPS-en (`deploy/compose.prod.yaml`), az image a ghcr.io-ról. A `main`-re pusholáskor a CI SSH-n telepít, ha a repóban be van állítva a `VPS_HOST` változó (mellette `VPS_USER`, opcionálisan `VPS_PORT`, `VPS_PATH`; secretek: `VPS_SSH_KEY`, `VPS_SSH_HOST_KEY`). Egyszeri parancs: `docker compose exec scheduler node src/cli/index.ts <parancs>`.

Az R2 S3-feltöltéssel nem lehet `X-Robots-Tag` fejlécet adni, ezért a riport-bucket custom domainjére Cloudflare Transform Rule kell (Modify Response Header): `X-Robots-Tag: noindex, nofollow`.

## Fejlesztés

- `TASKS.md`: haladás

A riport snapshotjának frissítése szándékos változás után: `node --test --test-update-snapshots tests/report.test.ts`. Az email-sablon módosítása után: `npm run build:email`.

## Licenc

[MIT](LICENSE)
