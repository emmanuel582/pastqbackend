FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . ./

RUN mkdir -p /var/lib/pastq && chown -R node:node /app /var/lib/pastq
USER node

EXPOSE 3000
VOLUME ["/var/lib/pastq"]

CMD ["node", "index.js"]
