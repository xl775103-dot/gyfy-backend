FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip curl unzip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp==2026.10.26 \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
