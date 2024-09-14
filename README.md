# Nanit Camera

Description

# Installation

```sh
npm i --save nanit-camera
```

# Usage

#### Supports both ESM and CommonJS

```js
// esm
import nanit from 'nanit-camera'
// commonjs
const NanitClient = require('nanit-camera').NanitClient
const NanitService = require('nanit-camera').NanitService
```

#### Nanit API Service (recommended)

```js
// esm
import { NanitService } from 'nanit-camera'

const nanitService = new NanitService()

nanitService
  .start()
  .then(() => {
    console.log('NanitService started')
  })
  .catch((err) => {
    console.log('NanitService start failed!')
    console.error(err)
    process.exit(1)
  })

process.on('SIGINT', () => {
  nanitService
    .stop()
    .then(() => {
      console.log('NanitService stopped')
      process.exit(0)
    })
    .catch((err) => {
      console.log('NanitService stop failed!')
      console.error(err)
      process.exit(1)
    })
})
```


#### Nanit API Client

```js
// esm
import { NanitClient } from 'nanit-camera'
// commonjs
const NanitClient = require('nanit-camera').NanitClient

const nanit = new NanitClient()

// nanit.login...
```

# License

MIT
