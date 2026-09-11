# Deploy da API na VPS

A API é Node.js/Fastify e usa o `Dockerfile` deste diretório. Ela não precisa de `index.html`.

## Segredos

O `.env` nunca deve ser commitado. O `.dockerignore` também impede que ele entre na imagem.
Na VPS, crie um arquivo externo, por exemplo `/etc/sysaceite/api.env`, com as variáveis do
`.env.example` preenchidas. No mínimo, `DATABASE_URL` e `JWT_SECRET` são obrigatórias.

```bash
chmod 600 /etc/sysaceite/api.env
docker build -t sysaceite-api .
docker run -d --name sysaceite-api --restart unless-stopped \
  --env-file /etc/sysaceite/api.env \
  -p 3333:3333 sysaceite-api
```

Também é possível definir `ENV_FILE=/caminho/seguro/api.env` ou injetar as variáveis diretamente
no ambiente do container. Não use `COPY .env` no Dockerfile.

## Verificação antes de iniciar

```bash
docker run --rm --env-file /etc/sysaceite/api.env sysaceite-api npm run env:check:dist
```

Se o container entrar em `crash-loop` com `nenhum arquivo .env encontrado`, o arquivo não foi
montado ou as variáveis não foram injetadas. O `.env` que existe no computador local não é
enviado automaticamente pelo GitHub ou pelo deploy.
