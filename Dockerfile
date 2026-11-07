FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts tsconfig.json ./
COPY src ./src

RUN mkdir -p /data/config/cosmos-mcp \
  && chmod 0700 /data/config /data/config/cosmos-mcp \
  && chown -R bun:bun /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    XDG_CONFIG_HOME=/data/config

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`); process.exit(res.ok ? 0 : 1)"]

ENTRYPOINT ["bun", "run", "index.ts"]
CMD ["serve"]
