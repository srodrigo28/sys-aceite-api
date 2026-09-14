# Guia reutilizável: deploy de aplicações Node.js em VPS

> **Guia reutilizável, não backlog.** Para o deploy e as evidências específicas do SysAceite,
> consulte [../13-setembro-fechamento-gaps.md](../13-setembro-fechamento-gaps.md).

Guia para aplicações Node.js/Fastify, Express ou similares que usam uma porta HTTP e variáveis
de ambiente secretas.

## Pré-requisitos

```bash
node --version
npm --version
docker --version
```

Esta API usa Node.js 22 no container; o `package.json` aceita Node.js 22 a 24.

O projeto deve ter `package.json`, `package-lock.json`, scripts `build` e `start`,
`.env.example` sem valores reais e um `Dockerfile` na raiz.

## Repositório privado

Use uma chave SSH de deploy ou token com acesso mínimo. Nunca coloque token na URL do Git.

```bash
sudo mkdir -p /opt/apps
sudo chown -R "$USER":"$USER" /opt/apps
cd /opt/apps
git clone git@github.com:ORGANIZACAO/REPOSITORIO.git app
cd app
```

Se houver vários projetos, entre na pasta correta antes do build:

```bash
cd /opt/apps/app/api
```

## Segredos fora do Git

Este e o modelo recomendado para producao. No SysAceite, durante a fase atual de
desenvolvimento, o `api/.env` e versionado e copiado pela imagem Docker; nesse caso use o
procedimento de `DEPLOY.md`. Antes de abrir o repositorio ou promover para producao, migre de
volta para este modelo externo.

```bash
sudo mkdir -p /etc/minha-app
sudo nano /etc/minha-app/app.env
sudo chmod 600 /etc/minha-app/app.env
```

Use `.env.example` como modelo. Nunca envie `.env` ao GitHub, à imagem Docker ou aos logs.
Para esta API, `DATABASE_URL` e `JWT_SECRET` são obrigatórias:

```env
DATABASE_URL=[CREDENCIAL_REMOVIDA]
JWT_SECRET=[CREDENCIAL_REMOVIDA]
NODE_ENV=production
HOST=0.0.0.0
PORT=3333
```

## Build e validação

```bash
npm ci
npm run build
npm run env:check:dist
```

Antes de colocar uma versão nova no ar, aplique as migrations do banco. Não as execute durante
o `docker build`: nesse momento o banco pode não estar acessível e o build deve continuar
reproduzível.

## Deploy com Docker

```bash
# Para o SysAceite, a partir da pasta api:
chmod +x deploy-vps.sh
ENV_FILE=/etc/minha-app/app.env ./deploy-vps.sh
```

Verifique:

```bash
docker ps
docker logs --tail 100 minha-app
curl http://127.0.0.1:3333/health
```

Troque `/health` pela rota de saúde do projeto.

## Atualização

```bash
cd /opt/apps/app
git pull --ff-only
cd api
ENV_FILE=/etc/minha-app/app.env ./deploy-vps.sh
```

## Diagnóstico de crash-loop

```bash
docker ps -a
docker logs --tail 200 minha-app
docker inspect minha-app --format '{{.State.Status}} - {{.State.ExitCode}} - {{.State.Error}}'
sudo test -r /etc/minha-app/app.env && echo 'arquivo encontrado'
docker run --rm --env-file /etc/minha-app/app.env sysaceite-api:latest npm run env:check:dist
```

Se aparecer `nenhum arquivo .env encontrado`, o arquivo não foi montado. Se aparecer
`DATABASE_URL` ou `JWT_SECRET` indefinida, confira os nomes sem imprimir o conteúdo do arquivo.

## Checklist para novos projetos

- [ ] `npm ci`, `npm run build` e `npm start` funcionam.
- [ ] `HOST=0.0.0.0` e `PORT` são configuráveis.
- [ ] Existe uma rota `/health`.
- [ ] O Dockerfile não contém `COPY .env`.
- [ ] `.env` e `.env.*` estão no `.gitignore`.
- [ ] Segredos ficam fora do repositório, com permissão `600`.
- [ ] O container usa `--restart unless-stopped`.
- [ ] O deploy valida o ambiente e aplica migrations antes de trocar o container.
- [ ] Existe `HEALTHCHECK` e `/health` responde depois do deploy.
- [ ] O ambiente é validado antes de iniciar.
- [ ] Logs nunca exibem senhas ou tokens.
