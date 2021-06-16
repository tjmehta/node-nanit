import Nanit, { setFetch } from '../index'

import fetch from 'node-fetch'

const opts = {
  email: process.env.EMAIL ?? 'testuser',
  password: process.env.PASSWORD ?? 'testpassword',
}

setFetch(fetch)

describe('Nanit', () => {
  it('should create instance of api client', () => {
    const nanit = new Nanit(opts)
    expect(nanit).toBeInstanceOf(Nanit)
  })

  it('should login', async () => {
    const nanit = new Nanit(opts)
    await nanit.login()
  })
})
