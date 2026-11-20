# Decisões de recepção: retorno, espera e recusa

A homologação atual parte da PR #13 (`995c296`). Os cinco motores e os 357 testes anteriores permanecem sem alterações. Não há migração SQL nova ou modificada.

## Recusa reversa e retorno à aba

A verificação de recusa lê `companyLine` (a mesma ordem direta já existente da empresa), filtra presentes elegíveis e livres e verifica se o chamado é o 1º ou 2º desse recorte. O candidato reservado pela própria chamada está em `em_mesa`, ainda sem iniciar atendimento; somente ele é considerado nessa condição. Outras chamadas, atendimentos, pausas, restrições e saída após atendimento são excluídos. A consulta não escreve posições ou ponteiros.

O painel Motor da Fila passa a apresentar as mesmas decisões da Recepção e recarrega imediatamente depois de “Chamar do decorado”. Antes, a rotina gravava a chamada, mas essa tela não apresentava a recusa e dependia do polling para atualizar os dados. A aplicação usa o rótulo “Recusar (Ir para o Fim da Fila Reversa)”; a configuração padrão dos componentes independentes mantém o rótulo anterior para compatibilidade. A ação continua chamando `refuseInverseCall`, sem alterações nessa rotina: preserva a direta, move apenas a inversa, repassa a chamada e audita.

`src/modules/teste/TestSession.tsx` é o responsável pelo estado ativo do TESTE e pela instalação do relógio virtual. A preferência `plantao_test_enabled`, o horário `plantao_test_timestamp` e a duração das chamadas ficam em localStorage. A inicialização restaura essa fonte antes de montar a aplicação e consultar o banco. Desmontar o painel ou alternar abas não grava a preferência como desativada; somente o botão TESTE a altera. O relógio também salva o instante em `visibilitychange` e `pagehide`.

Ao receber `focus` ou voltar a ficar visível, a aplicação publica o relógio ativo e recarrega os dados. Sorteios, sessão ativa e fechamento são consultados para a data desse relógio. Enquanto aguarda ou em caso de erro, mantém a última tela carregada. Respostas de outra data/modo, de componentes desmontados ou anteriores a uma resposta já aplicada são descartadas. Consultas lentas ainda podem atualizar a tela enquanto uma mais nova estiver pendente.

Para remover TESTE em produção, remover o painel `TestModule` e o invólucro `TestSession` da aplicação. A fonte nativa de `plantaoClock` e `SimProvider` continua sendo o relógio real, sem alterar regras de distribuição.

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
