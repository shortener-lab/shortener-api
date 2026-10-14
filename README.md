# shortener-api

API e worker do encurtador de URLs (Node 24, Express 5, Postgres, Valkey, Kafka).

- Dev local: `docker compose up -d` e `npm run dev:api` (veja `.env.example`).
- Testes: `npm test` (precisa do compose de pé).
- Imagem: `ghcr.io/shortener-lab/shortener-api:sha-<7>`.

O plano do projeto, a infraestrutura e o deploy vivem no [shortener-deploy](https://github.com/shortener-lab/shortener-deploy/tree/main/docs/plano).
