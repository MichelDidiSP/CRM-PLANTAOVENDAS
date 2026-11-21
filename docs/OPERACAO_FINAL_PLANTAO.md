# Operação final do plantão

## Implantação

Aplicar **uma vez**, após as migrações já instaladas, `supabase/migrations/20261121140000_plantao_final_operations.sql`, antes de publicar este frontend. Não reaplicar as cópias antigas duplicadas de migrações. O workflow `Validar CRM` mostra a sequência de instalação em banco limpo.

A migração adiciona a categoria Agendado e seus campos, os contratos de fechamento automático/extensão e a tabela privada de indicadores. Preserva os dados e as migrações anteriores. O reset continua exigindo intenção explícita de TESTE e preserva os fatos quantitativos e os indicadores históricos.

## Horário e encerramento

A recepção/gerência possui a chave **Dia de Assinatura Caixa (Estender Plantão)**, desativada por padrão para cada data. A configuração é compartilhada no banco, em `plantao_sessions` com identificador `operation_<data>` e status `ended`; não ocupa uma sessão ativa de sorteio.

O relógio ativo dispara `close_plantao_automatically` ao atingir ou ultrapassar 21h. A transação reconsulta a chave sob o mesmo bloqueio do fechamento oficial, reutiliza o snapshot definitivo existente e registra `fechamento_automatico_21h`. O resumo aparece imediatamente, com os links de WhatsApp/E-mail dos destinatários já cadastrados. O envio continua dependente do operador no aplicativo de destino.

Com a chave ativada, uma projeção exclusiva de despacho mantém a última janela aberta do dia para os motores congelados. A hora exibida, as datas gravadas, as chamadas e o prazo contínuo de pausa usam o relógio ativo verdadeiro. A chave não altera sorteios nem as filas. Desligá-la depois das 21h habilita o fechamento automático no próximo processamento; o botão **Fechar Plantão** segue disponível durante a extensão.

O gatilho pertence à aplicação aberta, não a um cron de servidor: se não houver nenhuma instância ativa, a execução ocorrerá quando a aplicação voltar a processar o relógio dentro do dia operacional. Sem o módulo TESTE, a origem é o relógio real.

## Atendimento Agendado

O motivo possui horário opcional e corretor designado opcional. O horário é informativo sobre a visita recebida; não cria um agendamento futuro nem bloqueia atendimento antecipado. O telefone com DDD permanece obrigatório, seguindo o cadastro qualificado da Primeira Visita. Sem telefone, permanece a regra existente do Decorado.

Sem corretor designado, segue a vez normal da fila direta. Com designação, aguarda esse corretor estar presente, elegível e livre. O chamado reserva o corretor; a conclusão consome a vez e o coloca no fim da fila direta, exatamente no momento em que a Primeira Visita faz isso. Não modifica a fila inversa. A designação é armazenada separadamente do corretor original de retorno e não gera Fifty.

Telefones conhecidos continuam preenchendo Retorno por padrão. A recepção pode optar explicitamente por **Registrar como Atendimento Agendado**. A categoria aparece nos relatórios de turno, dia, semana, demais períodos, exportação e snapshot. O snapshot preserva também o horário e a designação.

## Indicadores para Vendas

`crm_private.merit_indicator_events` armazena `broker_id`, `indicator`, `occurred_at`, `source_key` e `is_test`. A chave única `(indicator, source_key)` impede duplicação. Não há pesos, posição, nota ou ranking. Acesso público só pelos contratos específicos; a tabela não é exposta.

Indicações e Retornos são capturados quando o atendimento passa a `em_atendimento` (ou chega válido como `concluido`). Apenas cadastrar ou chamar não conta. O crédito pertence ao corretor original, inclusive no Fifty; sem original informado, ao corretor atendente. A conclusão não duplica nem muda a data já registrada.

O serviço `src/lib/operations/meritIndicators.ts` oferece `recordSalesMeritEvent` para `reserva` e `pasta_documentos` e `meritIndicatorCounts` para os quatro indicadores. Vendas deve fornecer um identificador estável, por exemplo `reserva:<id>`, e a data efetiva do evento. Repetições idênticas são aceitas; reapresentar a mesma chave com dados diferentes gera erro. A consulta usa início inclusivo e fim exclusivo, excluindo TESTE por padrão. Não preenche retrospectivamente os atendimentos anteriores à instalação.

## Validação

`npm test`, `npm run typecheck` e `npm run build`. Os testes novos estão em `src/modules/teste/finalOperations*`. Os 365 testes anteriores e os cinco motores congelados são comparados contra a PR 17 pela CI.

`supabase/tests/plantao_final_operations.sql` testa os RPCs, snapshots, Agendado e indicadores com PostgreSQL e pg-safeupdate. Os testes SQL anteriores também continuam executando. A CI verifica ainda a barra fixa em Chromium nas larguras de 1440, 1024 e 390 pixels.
