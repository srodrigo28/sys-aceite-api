# Deploy da API na VPS

A API é Node.js/Fastify e usa o `Dockerfile` deste diretório. Ela não precisa de `index.html`.

## Ambiente e segredos

O Dockerfile não copia `.env` nem qualquer segredo para a imagem. Desenvolvimento local continua
usando `api/.env`; no container, `DATABASE_URL`, `JWT_SECRET` e demais variáveis são injetadas por
arquivo externo ou pelo ambiente do processo. Isso permite trocar credenciais sem reconstruir a
imagem e impede que elas apareçam nas camadas Docker.

```bash
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
# Preencha DATABASE_URL e JWT_SECRET neste arquivo, ou forneça-os pelo painel.
docker build -t sysaceite-api:latest .
docker run -d --name sysaceite-api --restart unless-stopped \
  --env-file .env.deploy -p 3333:3333 sysaceite-api:latest
```

Também é possível definir `ENV_FILE=/caminho/seguro/api.env` ou injetar as variáveis diretamente
no ambiente do container. Nunca adicione `COPY .env` ao Dockerfile.

## Verificação antes de iniciar

```bash
docker run --rm --env-file .env.deploy sysaceite-api:latest npm run env:check:dist
```

Se aparecer `nenhum arquivo .env encontrado`, confira o `--env-file`, `ENV_FILE` e as permissões
do arquivo externo. A checagem precisa receber o mesmo ambiente que será usado pelo container;
rodá-la sem `--env-file` só é correto quando todas as variáveis já foram injetadas no processo.
O script `deploy-vps.sh` continua disponível para o modelo com `--env-file`.
