FROM node:20-bullseye

ADD . /app

WORKDIR /app
RUN npm install
RUN npm run build

CMD ["node", "dist/esm/app.mjs"]
