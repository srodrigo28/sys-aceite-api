# Deploy da API na VPS

A API é Node.js/Fastify e usa o `Dockerfile` deste diretório. Ela não precisa de `index.html`.

## Ambiente de desenvolvimento

Nesta fase, `api/.env` e incluído no repositório e na imagem Docker. Portanto, o deploy
recebe `DATABASE_URL` e `JWT_SECRET` diretamente do arquivo. Para produção, volte ao modelo
de arquivo externo com `--env-file` antes de abrir o repositório ou conceder acesso amplo.

```bash
git add .env
git commit -m "configura ambiente de desenvolvimento"
git push
docker build -t sysaceite-api:latest .
docker rm -f sysaceite-api 2>/dev/null || true
docker run -d --name sysaceite-api --restart unless-stopped -p 3333:3333 sysaceite-api:latest
```

Também é possível definir `ENV_FILE=/caminho/seguro/api.env` ou injetar as variáveis diretamente
no ambiente do container. Não use `COPY .env` no Dockerfile.

## Verificação antes de iniciar

```bash
docker run --rm sysaceite-api:latest npm run env:check:dist
```

Se aparecer `nenhum arquivo .env encontrado`, confira se o arquivo foi incluído no commit e se
o build ocorreu depois dele. O script `deploy-vps.sh` continua disponível para o modelo externo
de produção com `--env-file`.
