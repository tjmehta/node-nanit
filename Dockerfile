FROM node:lts

ADD . /app

WORKDIR /app
RUN npm install
RUN npm run build

CMD ["node", "dist/esm/app.mjs"]
