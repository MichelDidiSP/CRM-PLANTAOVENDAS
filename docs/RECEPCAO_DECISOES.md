# Decisões de recepção: retorno, espera e recusa

Esta alteração parte da PR #11 (`cef62a8`). Os cinco motores e os 273 testes anteriores permanecem sem alterações. Não há migração SQL nova ou modificada.

## Fluxo operacional

| Situação | Decisão | Resultado |
|---|---|---|
| Telefone completo encontrado em `visits` | Automática | Retorno e corretor original identificados; não exige seleção manual |
| Telefone desconhecido, Retorno escolhido manualmente | Selecionar original | Mantém o fallback manual |
| Todos ausentes; cliente novo, decorado ou sem telefone | Sim, aguardar | Espera prioritária; primeiro corretor elegível que chegar, 100% |
| Todos ausentes; cliente novo | Não aguardar | Base exclusiva da Incorporadora e fato quantitativo pelo RPC já existente |
| Todos ausentes; retorno/indicação específica | Sim, aguardar original | Espera nominal exclusiva, 100% para o original |
| Todos ausentes; retorno/indicação específica | Não aguardar original | Espera prioritária de chegada com Split quando outro corretor atender |
| Espera nominal; cliente mudou de ideia | Atender com outro | Último livre da equipe, depois da empresa, depois da outra empresa; Split |
| Mudança de ideia, ainda sem presentes | Atender com outro | Converte para espera prioritária de chegada com Split |
| Decorado/sem telefone em chamada inversa | Recusa pelo 1º/2º direto da empresa | Mantém a ordem direta, move apenas a inversa, chama próximo e audita |

Ausentes, pausados, ocupados, parceiros externos e corretores restritos a indicações não são alternativas gerais elegíveis. A espera nominal não impede o atendimento de outros clientes. Split não é aplicado contra o próprio corretor original se ele mesmo for o primeiro elegível.

O telefone é normalizado antes da consulta. A busca aguarda a seleção do banco (`dbReady`), inclui visitas fictícias somente com relógio TESTE ativo e usa `visitOwner` do motor congelado para preservar o primeiro vínculo. Uma resposta assíncrona antiga não sobrescreve um telefone novo. O formulário é revalidado na submissão.

## Organização e persistência

- `returnLookup.ts`: consulta histórica da interface.
- `operationalChoices.ts`: decisões adicionais e validação do direito de recusa; reutiliza a cobertura reversa do núcleo congelado.
- `operationalStore.ts`: persistência, chamada pela RPC existente, mudança de opinião e recusa.
- `ReceptionActions.tsx`: ações na Recepção, sem telefone no painel operacional.
- `ReceptionAuditPanel.tsx`: eventos de espera, mudança de opinião e recusa.

As decisões ficam no campo JSON **já existente** `plantao_sessions.schedule_data`, em registros `reception_<queue_entry_id>` com `kind: reception_v1` e `status: ended`. Não são sessões ativas nem sorteios. A agenda usa seus próprios IDs `schedule_*`. Esses registros não contêm nome ou telefone de cliente, sobrevivem à atualização da página e são removidos pelo reset diário existente.

A RPC `claim_reception_call` continua responsável pela reserva da chamada. Sua versão instalada rejeita `split=true` entre corretores da mesma imobiliária. Nessa situação, a orquestração reserva a chamada com a assinatura existente e grava `commission_split` e o rótulo correto em seguida. Essas gravações são idempotentes; o carregamento da aplicação completa metadados se uma falha de rede interromper essa etapa. Não se trata de uma nova transação SQL única.

Recusas e mudanças de opinião reservam a entrada com atualização condicional antes de alterar a decisão. Cliques de recusa atrasados conferem corretor e horário da chamada; confirmações e temporizadores não podem sobrescrever uma entrada já reservada. A recusa nunca escreve `sorteio_order`.

## Validação

- Suíte original preservada, mais testes de unidade, interface completa e contrato RPC em `src/modules/teste/reception*.test.*`.
- `supabase/tests/reception_choices.sql` verifica, como `anon`, a persistência no JSON existente, o Split na equipe, a recusa sem alteração direta e a limpeza desses metadados pelo reset. É apenas um teste transacional com `ROLLBACK`.
- CI mantém as proteções dos motores/testes antigos e verifica que `supabase/migrations` não mudou.

Para conferir na tela: ativar TESTE às 08:30, cadastrar cliente antes da chegada, escolher Sim/Não e registrar presença no painel do corretor. Para retorno, usar no formulário o telefone de uma visita com corretor identificado no quadro TESTE. Após o sorteio, chamar um Decorado e conferir o direito de recusa na Recepção e o evento na Auditoria.
