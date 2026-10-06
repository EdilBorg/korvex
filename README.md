# Korvex

**Versão:** 4.3.1 (refactored)

Sistema de automação e gestão com flow builder, inbox, analytics, IA e integração WhatsApp.

## Estrutura do projeto

```
korvex/
├── index.html              # Landing + app shell
├── components/             # Componentes da landing (Hero, Navbar, etc.)
├── css/                    # Estilos (landing, dashboard, flow-builder, inbox, ia...)
├── js/                     # Frontend (auth, dashboard, flow-builder, inbox, admin...)
├── server/                 # Backend Node.js
│   ├── engine/             # Flow engine, graph, executors
│   ├── whatsapp/           # Sessões e recovery WhatsApp
│   ├── plans/              # Controlo de planos
│   ├── payments/           # PaySuite
│   ├── credits/            # Créditos e uso de IA
│   └── ...
├── docs/                   # Termos e privacidade
├── firestore.rules
├── firestore.indexes.json
└── firebase.json
```

## Notas importantes

- O ficheiro `server/.env` **não** foi incluído (contém segredos reais).
- Usa `server/.env.example` como base e preenche as tuas chaves.
- Este repositório recebeu o código extraído de `korvex-refactored-4.3.1.zip`.

## Como correr

1. Frontend: servir a pasta raiz (ex: Live Server na porta 5500)
2. Backend: `cd server && npm install && npm start` (porta 3001)

## Relatórios incluídos

- `REFACTORING_CHANGELOG.md`
- `RELATORIO_FINAL_v4.3.1.md`
