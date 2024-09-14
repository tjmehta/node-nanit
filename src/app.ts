import AppServer from "./server/AppServer";

const appServer = new AppServer();

appServer
  .start()
  .then(() => {
    console.log("NanitService started");
  })
  .catch((err) => {
    console.error("NanitService start failed!", { err });
    process.exit(1);
  });

process.on("SIGINT", () => {
  appServer
    .stop()
    .then(() => {
      console.log("NanitService stopped");
      process.exit(0);
    })
    .catch((err) => {
      console.error("NanitService stop failed!", { err });
      process.exit(1);
    });
});
