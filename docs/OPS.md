# Korvex — Operações (Fase 0)

Documento operacional. Não altera o comportamento do produto; serve para equipa e deploys.

---

## Checklist Fase 0 (concluída)

- [x] Auditoria de segredos no repositório
- [x] `.gitignore` na raiz (`.env`, `serviceAccountKey.json`, `auth/`, `node_modules`, logs)
- [x] `server/.env.example` limpo (sem chaves reais)
- [x] Health checks: `/health`, `/health/workers`, `/health/memory` (já existiam no servidor)
- [x] README operacional (como subir localmente)
- [x] Branch `develop` para trabalho contínuo
- [x] Nenhuma alteração ao motor de fluxos, Baileys, frontend de negócio ou planos

---

## Segredos — o que NUNCA vai para o Git

| Ficheiro / dado | Onde fica |
|-----------------|-----------|
| `server/.env` | Só na máquina / servidor |
| `server/serviceAccountKey.json` | Só na máquina / servidor |
| `GEMINI_API_KEY` | Variável de ambiente |
| `PAYSUITE_API_TOKEN` / `PAYSUITE_WEBHOOK_SECRET` | Variável de ambiente |
| Pastas `server/auth/` (credenciais Baileys em disco) | Disco do servidor (já no `.gitignore`) |

Se algum secret chegou a ser commitado no passado: **rodar a chave** (Gemini, PaySuite, Firebase) e garantir que o ficheiro está no `.gitignore`.

---

## Health checks (monitorização)

| Endpoint | Uso |
|----------|-----|
| `GET /health` | Liveness geral |
| `GET /health/workers` | Estado do worker pool Baileys |
| `GET /health/memory` | Memória; responde **503** se memória crítica |

Exemplo:

```bash
curl -s http://localhost:3001/health
curl -s http://localhost:3001/health/workers
curl -s http://localhost:3001/health/memory
```

---

## Arranque local (resumo)

```bash
# Backend
cd server
cp .env.example .env   # preencher
# Colocar serviceAccountKey.json em server/
npm install && npm start

# Frontend (outro terminal, na raiz do repo)
npx --yes serve -p 5500 .
```

---

## Backup Firestore (manual — Fase 0)

Ainda não há job automático. Procedimento mínimo:

1. Firebase Console → Firestore → exportar coleções críticas quando necessário  
   (`workspaces`, `admins`, `admin_stats`, pagamentos)
2. Ou usar `gcloud firestore export` se tiveres GCP configurado

Nas fases seguintes (observabilidade / escala) entra backup automático.

---

## O que a Fase 0 **não** mudou (de propósito)

- Motor de fluxos (`server/engine/**`)
- Baileys / worker pool / recovery
- Frontend (dashboard, inbox, flow-builder, admin)
- Regras de planos e pagamentos
- Firestore rules

Assim o que já funciona continua a funcionar.
