# Guia reutilizável: deploy de aplicações Node.js em VPS

Guia para aplicações Node.js/Fastify, Express ou similares que usam uma porta HTTP e variáveis
de ambiente secretas.

## Pré-requisitos

```bash
node --version
npm --version
docker --version
```

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

```bash
sudo mkdir -p /etc/minha-app
sudo nano /etc/minha-app/app.env
sudo chmod 600 /etc/minha-app/app.env
```

Use `.env.example` como modelo. Nunca envie `.env` ao GitHub, à imagem Docker ou aos logs.
Para esta API, `DATABASE_URL` e `JWT_SECRET` são obrigatórias:

```env
DATABASE_URL=...
JWT_SECRET=...
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

## Deploy com Docker

```bash
docker build -t minha-app:latest .
docker run --rm \
  --env-file /etc/minha-app/app.env \
  minha-app:latest npm run env:check:dist
docker rm -f minha-app 2>/dev/null || true
docker run -d \
  --name minha-app \
  --restart unless-stopped \
  --env-file /etc/minha-app/app.env \
  -p 3333:3333 \
  minha-app:latest
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
docker build -t minha-app:latest .
docker rm -f minha-app 2>/dev/null || true
docker run -d --name minha-app --restart unless-stopped \
  --env-file /etc/minha-app/app.env \
  -p 3333:3333 minha-app:latest
```

## Diagnóstico de crash-loop

```bash
docker ps -a
docker logs --tail 200 minha-app
docker inspect minha-app --format '{{.State.Status}} - {{.State.ExitCode}} - {{.State.Error}}'
sudo test -r /etc/minha-app/app.env && echo 'arquivo encontrado'
docker run --rm --env-file /etc/minha-app/app.env minha-app:latest npm run env:check:dist
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
- [ ] O ambiente é validado antes de iniciar.
- [ ] Logs nunca exibem senhas ou tokens.
