FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
