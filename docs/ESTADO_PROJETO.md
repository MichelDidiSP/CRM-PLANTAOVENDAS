# Estado Atual do Projeto — CRM-PLANTAOVENDAS

- **Última PR integrada na `main`:** PR #18 (Commit `738f356`) — 402 testes aprovados.
- **Banco de Dados (Supabase / Bolt):** Migração `20261121140000_plantao_final_operations.sql` já aplicada (204k tokens restantes na conta ativa do Bolt.new).
- **Motores Congelados (Intactos):** `coreDistribution.ts`, `shiftSchedule.ts`, `pauseAndPartners.ts`, `intake.ts`, `fallbackOrchestrator.ts`.
- **Recursos Entregues no Módulo de Plantão:**
  - Fechamento automático às 21:00h + Chave *Dia de Assinatura Caixa (Estender Plantão)*.
  - Entrada *Atendimento Agendado* na Recepção e Relatórios (com fila própria de mérito planejada para a Fase 2).
  - Contadores datados de mérito preparados em `crm_private.merit_indicator_events` (*Indicações, Retornos, Reservas e Pastas de Documentos*).
  - Comissões divididas padronizadas visualmente como **Fifty**.
- **Pendências para a Retomada:**
  1. Revisar e corrigir os erros anotados nos **Diagramas 1, 2, 3 e 4** no `draw.io` (salvos em `docs/FLUXOGRAMA_PLANTAO.drawio.svg`).
  2. Iniciar **Fase 2**: Controle de Acesso/Perfis, Módulo de Vendas/Reservas/Pastas MCMV e Fila Semanal de Mérito (Sexta 19h).
