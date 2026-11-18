# Módulo TESTE

A PR #7 foi revertida em um commit separado (`git revert -m 1 46c727a`). O resultado desse commit é idêntico ao primeiro pai do merge, `43fa938`, que contém a PR #6 e a cópia aplicada de sua migração. O isolamento abaixo foi feito depois dessa reversão.

## Usar durante a validação

1. Abra **TESTE**, abaixo da navegação. Apenas enquanto estiver ativo aparecem os controles de horário, data, avanço de um minuto, salto para a tarde, duração de chamada e reinicialização.
2. Use o seletor original de motivo e **Simular Entrada Rápida**. A rotina da PR #6 foi movida da Recepção para `QuickEntryPanel.tsx` e continua chamando `dispatchBroker`, `resolveReceptionDispatch` e `claimReceptionCall`. Não há um segundo algoritmo de distribuição.
3. Consulte **Clientes Inseridos no Teste**. O quadro lista as visitas marcadas `is_test` e os leads diretos de teste. Nome e telefone são texto simples; não existe ação de copiar. A coluna de corretor usa o atendimento confirmado/concluído, não apenas o corretor indicado ou chamado. Clientes ainda não atendidos e registros exclusivos da Incorporadora ficam identificados.
4. Para testar retorno, digite o telefone apresentado no formulário normal da Recepção. A identificação usa o `lookupReturn` original.
5. Feche **TESTE** para voltar imediatamente ao relógio real, com chamadas de 120 segundos. Ao reabrir, o relógio virtual retoma o último horário salvo no navegador.

O reset permanece restrito à base local ou a uma instalação identificada com `VITE_PLANTAO_TEST_DATABASE=true`. Ele usa a rotina original de reinicialização, aguarda a agenda em andamento e libera o bloqueio de fechamento. O histórico quantitativo é capturado antes da limpeza das filas; visitas e leads históricos são preservados. Não emite o relatório final.

## Relógio único

`src/lib/plantaoClock.ts` fornece a hora real de São Paulo por padrão. `simContext.tsx` é a visão operacional desse relógio: não contém botões, estado de simulação ou setters de horário virtual. Os motores recebem os mesmos parâmetros e objetos de relógio que recebiam anteriormente.

Somente `src/modules/teste/virtualClock.ts` injeta outra fonte enquanto TESTE está ativo. Essa fonte também governa timestamps de chamadas/atendimentos, contagem regressiva da TV e atrasos de rechamada. A progressão considera o tempo decorrido desde a âncora, evitando perder segundos quando uma aba fica em segundo plano, e avança a data ao cruzar meia-noite.

Permanecem intactos os limites dos motores congelados:

| Evento | Limite preservado |
| --- | --- |
| Publicação do sorteio da manhã/integral | 08:46:00 |
| Fim da fila de chegada | 09:00:00 |
| Corte de presença da manhã | Após 09:30:00 |
| Publicação do sorteio da tarde | 13:46:00 |
| Virada efetiva para a tarde | 14:00:01 |
| Corte de presença da tarde | Após 14:30:00 |
| Restrição por pausa contínua | Após 120 minutos |

A referência do pedido a 14:00:00 difere em um segundo do motor original. Esse motor e seus testes foram preservados, sem compensações artificiais no relógio.

## Base e nomes dos corretores

O módulo TESTE usa a mesma instância Supabase da operação. O parâmetro `?simulacao=1` da PR #7 não tem mais efeito e não força troca para a base local. O módulo não insere, renomeia ou substitui corretores. Os cadastros He-Man/Casa Nobre e Trapalhões/Viva são preservados na conexão configurada.

A lista nominal desses personagens não está versionada no repositório da PR #6. A base local de contingência já continha nomes genéricos antes da PR #7; ela não é uma cópia do banco configurado. Por isso não foi inventada uma nova lista nem executada uma migração sobre os cadastros. Os nomes de personagens utilizados nos testes automatizados são apenas fixtures isoladas do Vitest.

## Remover o módulo na produção

Remova a importação e a montagem de `TestModule` em `src/App.tsx` e a pasta `src/modules/teste`. A fonte de tempo continuará real automaticamente. Nenhum arquivo congelado ou regra de fila precisa ser alterado. A função genérica `runMaintenance` em App também pode ser retirada quando não tiver mais consumidor.

O contexto operacional e `plantaoClock.ts` devem permanecer: a Recepção, Fila, TV e os adaptadores usam essa fonte comum tanto em produção quanto nos testes. O mock de contingência preexistente em `src/lib/mockClient.ts` não é ativado pelo módulo TESTE; seu protocolo de `update().select()` foi corrigido para reproduzir o retorno da API do Supabase, sem trocar os dados do banco configurado.

## Validação

Os cinco arquivos congelados e todos os arquivos dos 240 testes da PR #6 são comparados com a referência original no CI. Os testes adicionais ficam dentro do próprio módulo e exercitam a interface com os motores reais, incluindo retorno ao relógio real, publicação antecipada das filas, cortes de presença, pausa contínua, cronômetro da TV, entrada rápida, privacidade, reinicialização e preservação da conexão configurada.

## Gatilho automático dos sorteios

Abrir a aplicação pelo relógio real depois das janelas, ainda sem inscritos, podia criar registros de sorteio vazios em `plantao_sessions`. Ao ativar TESTE, registrar presença às 08:30 e avançar para 08:46, a agenda via o identificador já existente e ignorava os inscritos. O mesmo ocorria na tarde. Além disso, o efeito de `App.tsx` descartava alterações do relógio recebidas durante uma consulta em andamento.

O adaptador `shiftScheduleStore.ts` agora distingue um registro vazio de um sorteio com participantes. Somente registros vazios podem ser completados; sorteios válidos permanecem imutáveis. `App.tsx` guarda o horário mais recente recebido durante uma execução e o processa assim que a consulta termina, recarregando as filas para publicação. A ordem das imobiliárias só é instalada a partir de uma sessão com participantes. Os motores e limites de horário continuam iguais.

Antes de publicar a interface contra um Supabase existente, aplique a migração `20261117193000_retry_empty_shift_draws.sql`. Ela mantém a transação oficial e seu bloqueio por dia, permitindo substituir exclusivamente registros vazios. Não é necessário apagar histórico nem reiniciar um sorteio válido. A migração é necessária para recuperar registros vazios no banco remoto; o adaptador local reproduz a mesma decisão.

`automaticDraw.integration.test.tsx` acrescenta cinco cenários à suíte de 254 testes preservada: inscrição pelos botões reais e avanço a 08:46, salto a 08:50, inscrição da tarde e avanço a 13:46, salto durante consulta pendente e passagem de 08:45:59 a 08:46 pelo relógio real. Os testes verificam persistência, listas e ordem das imobiliárias na tela, ausência de novo sorteio e ativação posterior. `supabase/tests/automatic_draw.sql` valida também a recuperação e a imutabilidade pela função PostgreSQL. O CI compara os arquivos dos 254 testes anteriores com suas referências e executa ambos os grupos.
