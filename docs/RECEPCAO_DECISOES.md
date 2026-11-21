# Decisões de recepção: retorno, espera e recusa

A homologação atual restaura a PR #13 (`995c296`). Os cinco motores e os 357 testes dessa base permanecem sem alterações. Não há migração SQL nova ou modificada.

## Restauração da base estável

As alterações de sincronização da PR #14 (`fa8fd3f`) foram revertidas. O carregamento, a agenda, o relógio virtual e as rotinas de atendimento voltaram à implementação da PR #13, sem eventos próprios de `focus`, `visibilitychange` ou `pagehide`, sem `TestSession` e sem persistência da ativação do TESTE. A chave legada `plantao_test_enabled` é ignorada. O botão TESTE volta a controlar localmente a ativação; a persistência original do horário virtual foi mantida.

A barra de tempo da PR #15 permanece com `sticky top-0 z-40` e fundo opaco. O cabeçalho principal consulta a fonte de relógio já existente somente para sua classe de posicionamento, evitando sobrepor essa barra; não instala outro provedor ou evento.

O limite da barra foi ampliado para a página inteira: os invólucros do TESTE usam `display: contents`, e o antigo invólucro curto em App foi removido. A barra e o corpo rolável conservam o alinhamento, as cores e os espaçamentos do quadro anterior. A mudança é exclusivamente de estrutura/CSS; não adiciona estado, observadores ou eventos de rolagem/foco. Um novo teste Vitest verifica o contêiner da barra (365 testes no total). A verificação Chromium compara a geometria inicial com a PR #16 e percorre a rolagem completa em Recepção, Motor da Fila e Auditoria, em três larguras de tela.

O botão da Recepção usa o rótulo “Recusar (Ir para o Fim da Fila Reversa)” e a verificação pura já existente na PR #13: considera o 1º ou 2º livre elegível da empresa, na ordem direta atual. O candidato reservado pela própria chamada está em `em_mesa`, ainda sem atendimento; somente ele é considerado nessa condição. A verificação não escreve filas ou ponteiros, e a ação de recusa permanece intacta.

A suíte contém 364 testes: os 357 da PR #13, o teste original da barra fixa e seis testes adicionais de renderização e ciclo do TESTE. Os dez testes da PR #14 foram retirados junto com a funcionalidade revertida. Os testes novos verificam a recusa para o 1º/2º livre, a ausência de mutações durante a renderização e a ausência dos eventos de ciclo de aba removidos.

## Fluxo operacional

| Situação | Decisão | Resultado |
|---|---|---|
| Telefone completo encontrado em `visits` | Automática | Retorno, nome completo e corretor original preenchidos; nome editável e envio liberado |
| Telefone desconhecido, Retorno escolhido manualmente | Selecionar original | Mantém o fallback manual |
| Todos ausentes; cliente novo, decorado ou sem telefone | Sim, aguardar | Espera prioritária; primeiro corretor elegível que chegar, 100% |
| Todos ausentes; cliente novo | Não aguardar | Base exclusiva da Incorporadora e fato quantitativo pelo RPC já existente |
| Todos ausentes; retorno | Sim, aguardar original | Espera nominal; chegada do original atende diretamente com 100%; outro disponível gera proposta de Fifty |
| Todos ausentes; retorno | Não aguardar original | Espera prioritária; solicita decisão com Fifty quando outro corretor estiver disponível |
| Todos ausentes; indicação específica | Sim, aguardar original | Mantém a espera nominal e a ação explícita de mudança de opinião |
| Todos ausentes; indicação específica | Não aguardar original | Mantém o despacho prioritário ao primeiro corretor elegível, com Fifty se for outro corretor |
| Espera nominal; cliente mudou de ideia | Atender com outro | Último livre da equipe, depois da empresa, depois da outra empresa; Fifty |
| Mudança de ideia, ainda sem presentes | Atender com outro | Converte para espera prioritária de chegada com Fifty |
| Decorado/sem telefone em chamada inversa | Recusa pelo 1º/2º livre da empresa | Mantém a ordem direta, move apenas a inversa, chama próximo e audita |

Ausentes, pausados, ocupados, parceiros externos e corretores restritos a indicações não são alternativas gerais elegíveis. A espera nominal não impede o atendimento de outros clientes. O candidato chamado para o Decorado está em `em_mesa` por causa da própria chamada; ele entra na contagem de livres, mas outros chamados, em atendimento, pausados e ausentes são excluídos. A ordem direta não é escrita pela recusa. A auditoria distingue posição direta e posição entre livres. Fifty não é aplicado contra o próprio corretor original se ele mesmo for o primeiro elegível.

O telefone é normalizado antes da consulta. A busca aguarda a seleção do banco (`dbReady`), inclui visitas fictícias somente com relógio TESTE ativo e usa `visitOwner` do motor congelado para preservar o primeiro vínculo. Uma resposta assíncrona antiga não sobrescreve um telefone novo. O nome cadastrado é preenchido e pode ser complementado; trocar o telefone limpa a identidade anterior. O formulário revalida a busca na submissão antes de exigir o nome.

## Organização e persistência

- `returnLookup.ts`: consulta histórica da interface.
- `commissionLabels.ts`: apresenta rótulos históricos de comissão como Fifty, sem mudar os campos técnicos nem o motor congelado.
- `returnDecision.ts` / `returnDecisionStore.ts`: confirmação persistida antes dos despachos automáticos de retorno.
- `ReturnOfferPanel.tsx`: proposta e resposta na Recepção e na Fila.
- `operationalChoices.ts`: decisões adicionais e validação do direito de recusa; reutiliza a cobertura reversa do núcleo congelado.
- `operationalStore.ts`: persistência, chamada pela RPC existente, mudança de opinião e recusa.
- `ReceptionActions.tsx`: ações na Recepção, sem telefone no painel operacional.
- `ReceptionAuditPanel.tsx`: eventos de espera, mudança de opinião e recusa.

O despacho automático da agenda, da Recepção, da Fila e da reconvocação da TV passa por `dispatchReceptionEntry` / `dispatchWaitingWithDecisions`. As rotinas anteriores de execução continuam disponíveis para executar decisões já tomadas, inclusive a mudança de opinião explícita e a recusa de Decorado. A execução do motor por si só não constitui autorização automática para trocar o corretor de um retorno.

O corretor original disponível é atendido diretamente com 100%, mesmo se houver oferta de outro corretor pendente. Na ausência dele, a hierarquia e o modo de espera selecionam uma alternativa. A oferta mostra **Atender Agora (Com Fifty)** e **Continuar Aguardando Original**. A aceitação é vinculada ao corretor mostrado e confere novamente disponibilidade e identificação da oferta. Uma oferta desatualizada nunca troca silenciosamente o corretor. Enquanto o cliente decide, não é gravada uma chamada nem marcado o corretor como ocupado.

Ao continuar esperando, a escolha fica registrada e os corretores já disponíveis podem atender a fila normal. O mesmo intervalo de disponibilidade não gera alertas repetidos. Uma nova chegada/liberação pode gerar nova proposta, inclusive com o relógio virtual parado. A oferta e a resposta sobrevivem à atualização da página, em `returnConfirmation` no JSON existente.

As decisões ficam no campo JSON **já existente** `plantao_sessions.schedule_data`, em registros `reception_<queue_entry_id>` com `kind: reception_v1` e `status: ended`. Não são sessões ativas nem sorteios. A agenda usa seus próprios IDs `schedule_*`. Esses registros não contêm nome ou telefone de cliente, sobrevivem à atualização da página e são removidos pelo reset diário existente.

A RPC `claim_reception_call` continua responsável pela reserva da chamada. Sua versão instalada rejeita `split=true` entre corretores da mesma imobiliária. Nessa situação, a orquestração reserva a chamada com a assinatura existente e grava `commission_split` e o rótulo correto em seguida. Essas gravações são idempotentes; o carregamento da aplicação completa metadados se uma falha de rede interromper essa etapa. Não se trata de uma nova transação SQL única.

Recusas e mudanças de opinião reservam a entrada com atualização condicional antes de alterar a decisão. Cliques de recusa atrasados conferem corretor e horário da chamada; confirmações e temporizadores não podem sobrescrever uma entrada já reservada. A recusa nunca escreve `sorteio_order`.

## Validação

- Suíte original preservada, mais testes de unidade, interface completa e contrato RPC em `src/modules/teste/reception*.test.*`.
- `supabase/tests/reception_choices.sql` verifica, como `anon`, a persistência no JSON existente, o Fifty na equipe, a recusa sem alteração direta e a limpeza desses metadados pelo reset. É apenas um teste transacional com `ROLLBACK`.
- CI mantém as proteções dos motores/testes antigos e verifica que `supabase/migrations` não mudou.

Para conferir na tela: ativar TESTE às 08:30, cadastrar cliente antes da chegada, escolher Sim/Não e registrar presença no painel do corretor. Para retorno, usar no formulário o telefone de uma visita com corretor identificado no quadro TESTE. Após o sorteio, chamar um Decorado e conferir o direito de recusa na Recepção e o evento na Auditoria.

Os novos testes `fiftyDecision.test.ts` e `fiftyReception.integration.test.tsx` cobrem nome automático/editável, posições entre livres, propostas, aceitação/recusa, retomada após atualização, retorno do original, clique duplicado, perda de disponibilidade, Fila, agenda e reconvocação da TV. Nenhum arquivo SQL foi alterado nesta rodada.
