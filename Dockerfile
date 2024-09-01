FROM illuspas/node-media-server

ADD . /app

RUN cd /app && npm install
RUN cd /app && npm run build

CMD ["node", "/app/dist/esm/app.mjs"]
