# Korvex

**Versão:** 4.3.1 (refactored) · **Fase 0:** Fundação concluída

Sistema de automação de conversas WhatsApp (flow builder, inbox, analytics, IA, planos e pagamentos).

---

## Estrutura

```
korvex/
├── index.html              # Landing + app shell (SPA)
├── components/             # Componentes da landing
├── css/                    # Estilos
├── js/                     # Frontend
├── server/                 # Backend Node.js (Express + Baileys + Firebase Admin)
│   ├── engine/             # Motor de fluxos
│   ├── whatsapp/           # Sessões Baileys + recovery + worker pool
│   ├── plans/              # Controlo de planos (server-side)
│   ├── payments/           # PaySuite
│   ├── credits/            # Créditos de IA
│   ├── .env.example        # Modelo de variáveis (sem segredos)
│   └── ...
├── docs/                   # Documentação operacional e legal
├── firestore.rules
├── firestore.indexes.json
└── firebase.json
```

---

## Como correr (local)

### 1. Pré-requisitos
- Node.js ≥ 18
- Conta Firebase (Auth + Firestore)
- (Opcional) chave Gemini e conta PaySuite

### 2. Backend

```bash
cd server
cp .env.example .env
# Editar .env: preencher GEMINI_API_KEY, PaySuite, e colocar serviceAccountKey.json
npm install
npm start
# → http://localhost:3001
```

Health checks:
- `GET /health` — estado geral
- `GET /health/workers` — pool de workers Baileys
- `GET /health/memory` — memória do processo

### 3. Frontend

Servir a raiz do projeto (ex.: Live Server na porta 5500, ou `npx serve .`).

Abrir `http://localhost:5500`.

---

## Segurança (Fase 0)

- **Nunca** commits de `server/.env` nem `serviceAccountKey.json`
- `.gitignore` cobre: `.env`, chaves Firebase, pastas `auth/` do Baileys, `node_modules`, logs
- `server/.env.example` **não contém** valores reais — só placeholders
- Em produção: `NODE_ENV=production`

Ver também: [docs/OPS.md](docs/OPS.md)

---

## Branches

| Branch   | Uso |
|----------|-----|
| `main`   | Código estável / o que está no GitHub agora |
| `develop`| Trabalho contínuo de melhorias (fases seguintes) |

Melhorias por fase → branch `feature/...` ou commits em `develop` → só depois para `main`.

---

## Relatórios internos

- `REFACTORING_CHANGELOG.md` — stats admin O(1)
- `RELATORIO_FINAL_v4.3.1.md` — relatório da refatoração
- `docs/OPS.md` — operações e checklist Fase 0

---

## Roadmap (resumo)

| Fase | Foco |
|------|------|
| **0** | Fundação (segurança, gitignore, health, ops) ← **esta** |
| 1 | MVP de mercado (executores em stub, landing, legal) |
| 2 | Confiabilidade WhatsApp (sessões estáveis) |
| 3 | Throughput (filas + workers) |
| 4 | Observabilidade |
| 5 | Escala 5k utilizadores |
