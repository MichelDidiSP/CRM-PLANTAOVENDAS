# CRM-PLANTAOVENDAS

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-rnlzbfyx)

## Recepção e fechamento oficial

Aplique a migração `20261116230000_reception_fallback_and_official_closing.sql` no projeto Supabase do CRM. Ela cria a base privativa da Incorporadora, a fila de espera e o fechamento diário. Cadastre no Supabase Auth as contas dos operadores autorizados e vincule seus UUIDs em `crm_private.closing_operators`. Os papéis aceitos são `recepcao`, `gerencia` e `diretoria`. Cadastre os contatos da Gerência e da Diretoria em `crm_private.closing_recipients`, via SQL administrativo:

```sql
INSERT INTO crm_private.closing_operators (user_id, role)
VALUES ('00000000-0000-0000-0000-000000000000', 'gerencia');

INSERT INTO crm_private.closing_recipients (role, whatsapp, email)
VALUES ('diretoria', '5511999999999', 'diretoria@example.com');
```

Substitua os valores de exemplo pelos dados cadastrados. O WhatsApp exige DDI e DDD, só com dígitos. Visitas de parceria cadastradas pelo formulário dedicado guardam os dados completos em uma tabela privativa, enquanto as telas de chamada recebem apenas o primeiro nome do cliente. Os links abrem um rascunho com os totais e o operador confirma o envio. O cadastro nominal fica em `crm_private.plantao_daily_closures.customers`. A base `crm_private.incorporadora_direct_leads` e os snapshots não são consultáveis pela API pública. O split registra a ocorrência, o corretor original e o corretor efetivo, deixando o valor da comissão para o cálculo do módulo comercial.

O simulador em memória oferece o reset e o teste rápido. Em um Supabase reservado a testes, configure `VITE_PLANTAO_TEST_DATABASE=true` para exibir a geração de visitas fictícias. O reset global fica restrito ao simulador em memória. Se o fechamento for feito no simulador, o snapshot dura enquanto o ambiente estiver carregado.

Para validar o frontend, execute `npm ci`, `npm test`, `npm run typecheck` e `npm run build`.
