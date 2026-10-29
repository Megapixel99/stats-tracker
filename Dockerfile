FROM node:24-slim

WORKDIR /app

COPY package*.json ./

# The dashboard's dependencies are dev/peer dependencies of the package so
# that apps which only report stats never install them; the image needs them.
RUN npm ci --no-audit --no-fund

COPY . .

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "dashboard.js"]
