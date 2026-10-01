FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# COPY *.js ./ em vez de listar arquivo por arquivo: já derrubou deploy de outros apps
# desta VPS por esquecimento de um arquivo novo na lista (viabil-app, 18/08/2026).
COPY *.js ./
COPY schema.sql ./
COPY views ./views
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
