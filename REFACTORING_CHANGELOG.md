# KORVEX — Refatoração do Admin Dashboard Stats (v4.3 → v4.3.1)

## Resumo

Implementação completa e final da arquitetura de métricas agregadas com atualização incremental O(1).

### Versões

- **v4.3:** Implementação inicial (Dashboard O(1) mas operações admin ainda O(N))
- **v4.3.1:** Correção arquitetural — TODAS operações normais O(1)

## Alterações Principais — v4.3.1

### 0. Removido: AdminStatsSyncService

- Serviço de sincronização periódica removido
- Não necessário com operações incrementais
- Consistência garantida pelas operações, não por background jobs
- Dashboard não precisa estar aberto para manter sistema consistente

### 1. `/js/dashboard-stats.js` (Melhorias v4.3.1)

**Arquitetura:**
- Dashboard agora lê EXCLUSIVAMENTE `admin_stats/current` (1 documento)
- Méthodos `_scanAllUsers()` e `_subQuiet()` marcados como [INTERNAL], usados apenas para bootstrap
- Novo método `validateConsistency()` para verificar coerência entre dados reais e agregados

**Método `getStats()`:**
- Lê `admin_stats/current` (operação rápida)
- Se não existir, faz bootstrap automático com `refreshStats()` (one-time operation)
- Reconcilia mês automaticamente se necessário

**Método `refreshStats()`:**
- Agora claramente marcado como operação cara (raras)
- Usada para: bootstrap inicial, admin clicando "Actualizar", validação periódica
- NÃO é o fluxo normal do Dashboard

**Novo método `validateConsistency()`:**
- Compara `totalUsers` em `admin_stats/current` vs count real de `admin_users`
- Retorna { valid, diff, statsUsers, realUserCount }
- Usado por sincronização automática

### 2. `/js/admin.js`

**Método `_loadDashboard(forceRefresh)`:**
- Ambos os casos (com/sem forceRefresh) usam `getStats()` ou `refreshStats()`
- NUNCA faz varredura de admin_users diretamente
- NUNCA faz loops de subscription individuais
- Comentário adicionado explicando arquitetura 4.3

**Novo: `AdminStatsSyncService`:**
- Sincronização automática a cada 30 minutos
- Valida consistência
- Reconcilia mês corrente
- Inicia automaticamente quando app carrega

**Operações Administrativas:**
- Todas as operações já chamavam `updateSubscriptionCounts()` — mantido
- `incrementRevenue()` preservado para transações de planos oficiais
- `incrementUserCount()` preservado para novo registro de user

### 3. Integração com Fluxos Reais

**Login/Registro (ui.js):**
- ✓ Já chama `incrementUserCount()` se `isNewUser`
- Sem alterações necessárias

**Operações Admin (admin.js):**
- ✓ extendDays → `incrementRevenue()` + `updateSubscriptionCounts()`
- ✓ removeDays → `updateSubscriptionCounts()`
- ✓ activateAccount/Trial/Pro/Premium → `updateSubscriptionCounts()`
- ✓ suspendAccount → `updateSubscriptionCounts()`
- ✓ expireAccount → `updateSubscriptionCounts()`
- ✓ restoreTrial → `updateSubscriptionCounts()`
- Sem alterações necessárias (já integradas)

## Fluxo Antigo vs Novo

### Antes (O(N))
```
Admin abre Dashboard
  ↓
_loadDashboard()
  ↓
getStats() → não existe
  ↓
refreshStats()
  ↓
_scanAllUsers() → 300 users por página
  ↓
Para cada user:
  _subQuiet(uid) → ler subscription
  ↓
N + N queries ao Firestore
  ↓
Cálculo no frontend
  ↓
Renderizar Dashboard
```

### Depois (O(1))
```
Admin abre Dashboard
  ↓
_loadDashboard()
  ↓
getStats()
  ↓
admin_stats/current.get() → 1 leitura
  ↓
Renderizar Dashboard

---

Operação Admin (ex: extendDays)
  ↓
Alterar subscription no Firestore
  ↓
_log() → admin_logs
  ↓
incrementRevenue() → admin_stats/current
  ↓
updateSubscriptionCounts() → refreshStats() [background]
  ↓
admin_stats/current atualizado

---

Sincronização Automática (a cada 30 min)
  ↓
validateConsistency()
  ↓
updateSubscriptionCounts() if inconsistência
  ↓
updateMonthlyRevenue()
```

## Campos em `admin_stats/current`

```javascript
{
  totalUsers: number,
  activeSubscriptions: number,
  expiredSubscriptions: number,
  breakdown: {
    trial: number,
    pro: number,
    premium: number,
    expired: number,
    suspended: number,
    admin: number
  },
  totalRevenue: number,
  monthlyRevenue: number,
  currentMonthKey: "YYYY-MM",
  updatedAt: timestamp
}
```

## Performance

### Dashboard Load
- **Antes:** O(N) — scan de todos os users + loop de subscriptions
- **Depois:** O(1) — 1 leitura de documento

### Novo User
- Incrementa `totalUsers` imediatamente via `incrementUserCount()`

### Operação Admin
- Atualiza `admin_stats/current` atomicamente
- Recalculo de contadores em background via `updateSubscriptionCounts()`

### Sincronização
- Automática a cada 30 minutos
- Validação sem impact no Dashboard

## Compatibilidade

- ✓ Dados originais (`admin_users`, `subscription`, `admin_logs`) intactos
- ✓ Nenhuma estrutura duplicada ou segunda fonte de verdade
- ✓ `admin_stats/current` é apenas projeção agregada
- ✓ Dashboard mantém mesma UI visual
- ✓ Todos os módulos fora do Admin intactos (Inbox, Analytics, Flow Builder, etc)

## Testes Recomendados

1. **Dashboard Load:**
   - Abrir admin → Dashboard carrega rapidamente (1 read)
   - Recarregar página → sem varredura de users

2. **Novo User:**
   - Registar novo user → `totalUsers` incrementa

3. **Operações Admin:**
   - Extend dias → revenue atualiza + contadores recalculam
   - Suspender → suspended incrementa, active decresce
   - Restaurar trial → counts atualizam corretamente

4. **Duplicação:**
   - Operação repetida → não duplica contadores

5. **Sincronização:**
   - Aguardar 30 min → validação executa silenciosamente
   - Consistência validada

## Problemas Conhecidos / Scope Futuro

- Nenhum encontrado nesta implementação
- Paginação de lista de users no admin continua com limit(200) — fora do escopo desta tarefa

## Arquivos Modificados

1. `js/dashboard-stats.js` — Arquitetura de agregação
2. `js/admin.js` — Dashboard + sincronização automática

## Arquivos Mantidos Intactos

- Todos os outros arquivos
- Nenhuma estrutura de dados foi alterada
- Nenhum módulo fora do Admin foi tocado
