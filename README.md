# report-engine

[Magyar](README.hu.md)

Monthly website reports for a web agency's maintenance clients. Collects data daily (Search Console, uptime, worklog) into SQLite, publishes a monthly HTML report to R2 and sends an email summary. Nothing reaches the client without approval.

## How it works

```
daily        uptime (every 5 min), collect, backup
4th of month collect-monthly, report --live   → draft + preview email
manual       approve, send                    → R2 upload + email to the client
```

AI text is generated only with `report --live`. The model may not state any number that is not in its input. If it does, it gets one retry, then the report is built without AI text.

## Getting started

```
cp .env.example .env
cp config/clients/example.yaml config/clients/<id>.yaml
npm ci                     # Node 24
npm run cli -- status
npm run typecheck && npm test
```

With containers: `docker compose up -d scheduler`, one-off commands: `docker compose run --rm cli <command>`.

Commands: `status`, `collect`, `collect-monthly`, `uptime`, `backfill`, `log`, `report`, `approve`, `send`, `backup`, `restore`.

## Configuration

- `config/clients/<id>.yaml`: one file per client, see `example.yaml`.
- `config/prompts/*.md`: your own prompts, each overrides the generic one in `src/report/prompts/`.
- `BRAND_NAME`: your agency name in the report and email (optional).
- Secrets: env or `secrets/`, see `.env.example`.

`config/` (except `example.yaml`) and `secrets/` are neither in the repo nor in the image.

## Production

Rootless Podman + Quadlet on a VPS, image from ghcr.io, updated by `podman auto-update`.

R2 S3 uploads can't set an `X-Robots-Tag` header, so add a Cloudflare Transform Rule (Modify Response Header) on the report bucket's custom domain: `X-Robots-Tag: noindex, nofollow`.

## Development

- `TASKS.md`: progress

After an intentional report change, update the snapshot: `node --test --test-update-snapshots tests/report.test.ts`. After editing the email template: `npm run build:email`.

## License

[MIT](LICENSE)
