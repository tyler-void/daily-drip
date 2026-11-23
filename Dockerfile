# Bun runs the TypeScript directly, so there is no build stage.
# Keep this version the same as the one used for development (see README).
FROM oven/bun:1.3.14-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# A new named volume copies the ownership of the image directory it is mounted
# over, so /app/data must belong to the bun user (uid 1000) before the first start.
RUN mkdir -p /app/data /app/config && chown bun:bun /app/data

USER bun

# The bot handles SIGTERM and closes the Discord connection cleanly.
CMD ["bun", "src/main.ts"]
