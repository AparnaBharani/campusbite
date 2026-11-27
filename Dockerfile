FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY migrations ./migrations
RUN mkdir -p /home/node/.cache/campusbite && chown -R node:node /home/node/.cache/campusbite
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm", "start"]
