import AppServer from './server/AppServer'

const appServer = new AppServer()

appServer
  .start()
  .then(() => {
    console.log('AppServer started')
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

process.on('SIGINT', () => {
  appServer
    .stop()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
})
