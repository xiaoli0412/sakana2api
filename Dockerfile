FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY docker-entrypoint.sh /usr/local/bin/sakana-entrypoint.sh
RUN chmod +x /usr/local/bin/sakana-entrypoint.sh

EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/sakana-entrypoint.sh"]
