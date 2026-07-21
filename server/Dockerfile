FROM node:alpine3.24 AS builder

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci

# Copy the source code into the container and compile TypeScript.
COPY . .
RUN npm run build


# Deps stage: install production dependencies only.
FROM node:alpine3.24 AS deps

WORKDIR /app


RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --omit=dev


# Runner stage
FROM node:alpine3.24 AS runner

ENV PATH=/app/node_modules/.bin:$PATH

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/index.js"]
