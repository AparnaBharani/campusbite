FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY migrations ./migrations
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm", "start"]
