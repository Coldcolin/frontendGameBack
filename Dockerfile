# Backend image for Render (build context: this folder).
# The Playwright base image ships Chromium + its system libraries; keep its tag
# in sync with the `playwright` version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble AS build
WORKDIR /app
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
ENV NODE_ENV=production MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
