# report-engine – utasítások Claude Code-nak

Webügynökségek ügyfeleinek havi weboldal-riportját készítő rendszer (bárki használhatja; az ügynökség neve a `BRAND_NAME` env-ből jön, a kódban és a repóban nem szerepelhet). Napi adatgyűjtés → SQLite → havi HTML-riport R2-n + email-összefoglaló. A döntések a `docs/architecture.md`-ben, a fázisok a `docs/prompts.md`-ben vannak. Munka előtt olvasd el mindkettőt és a `TASKS.md`-t.

## Stack (rögzített, csak indokkal változtasd)

- Node.js 24, TypeScript közvetlenül futtatva (beépített type stripping), build lépés nélkül. `tsconfig`: `noEmit`, `strict`, `erasableSyntaxOnly`, `allowImportingTsExtensions`. Relatív importok `.ts` kiterjesztéssel.
- SQLite: `better-sqlite3`, WAL mód. Migrációk: `migrations/NNN_nev.sql`.
- Tesztek: `node:test`. Külső API-t teszt nem hív; fake adapterek és `tests/fixtures/`.
- CLI: `node:util` `parseArgs`, belépési pont `src/cli/index.ts`.
- Futtatás: konténerben, ütemezés supercronic-kal (`deploy/crontab`). Éles: Docker Compose a VPS-en (`deploy/compose.prod.yaml`), image a ghcr.io-ról, deploy a CI-ból SSH-n.

## Konvenciók

- A projekt fő nyelve az angol: kódazonosítók, kommentek és a `README.md` angolul (a `README.hu.md` a magyar változat). Ügyfélnek szóló szöveg magyarul, `hu-HU` számformátummal. „AI asszisztens” kötőjel nélkül.
- Minden gyűjtés idempotens: egy adott napra/hónapra újrafuttatva upsertel, nem duplikál.
- Egy ügyfél vagy forrás hibája nem állíthatja le a többit (`withRun`).
- Titok csak env-ből vagy a `secrets/` mappából jöhet. Soha ne kerüljön repóba, logba, hibaüzenetbe.
- Dátum tárolása `YYYY-MM-DD` / `YYYY-MM`. A Search Console napjai Pacific időzónában értendők; ne konvertáld őket.
- Új függőség csak akkor, ha a beépített Node-modul nem elég; az indok kerüljön a fázis-összefoglalóba.
- Könyvtár- és API-részleteket (verzió, metódusnév, paraméter) Context7-tel vagy a hivatalos dokumentációval ellenőrizd, ne emlékezetből. Amit nem tudtál ellenőrizni, jelöld.

## Munkamód

- Egy fázis = egy session. Ha egy lépéshez nem kell a döntésem, haladj tovább; az állapotjelzést a következő lépéssel együtt írd. Csak akkor állj meg, ha nélkülem nem tudsz továbbmenni, vagy destruktív művelet előtt.
- Ne commitolj: a diffet én nézem át.
- Fázis vége: `npm run typecheck` és `npm test` zöld, a `TASKS.md` frissítve.
- Minden futást három fejléccel zárj: **Rám vár**, **Változott**, **Találtam**.
