import replace from 'replace-in-file'

const dryRun = process.argv.includes('-dry')
if (dryRun) {
  console.warn('DRY RUN!')
} else {
  console.warn('WRITING TO FILES!')
}

const RECORDINGS_DIR = 'src/__tests__/__recordings__/'

replace.replaceInFileSync({
  // replace all tokens in recordings
  files: `${RECORDINGS_DIR}/**/*.har`,
  // token are in json strings with escaped quotes
  from: /(\\"([^"]*(token|phone|name|address|id|email|password|code|suffix|gender|relation))\\":[ ]?)((\\"([^"*]*)\\")|((?!9+$)[0-9]+))/gi,
  to: (...args) => {
    const file = last(args)
    const key = args[2]
    const value = args[6] ?? args[4]
    const censored = args[6]
      ? censoredValue(value, snakecase(key))
      : censoredValue(value, '', '9')

    if (value === censored) return args[0]
    if (key === 'ssid') return args[0]

    console.log(file.replace(RECORDINGS_DIR, ''), { key, value, censored })
    if (args[6] != null) {
      // string
      return '$1\\"$2\\"'.replace('$1', args[1]).replace('$2', censored)
    } else {
      // number
      console.log('$1$2'.replace('$1', args[1]).replace('$2', censored))
      return '$1$2'.replace('$1', args[1]).replace('$2', censored)
    }
  },
  dry: dryRun,
  verbose: true,
})

replace.replaceInFileSync({
  // replace all tokens in recordings
  files: `${RECORDINGS_DIR}/**/*.har`,
  // token are in json strings with escaped quotes
  from: /("([^"]*(value))":[ ]?)"(token [^*]*)"/g,
  to: (...args) => {
    const file = args[7]
    const key = args[2]
    const value = args[4]
    const censored =
      value.slice(0, 6) + censoredValue(value.slice(6), snakecase('token'))

    if (!value.startsWith('token')) {
      return args[0]
    }

    console.log(file, { key, value, censored })

    return '$1"$2"'.replace('$1', args[1]).replace('$2', censored)
  },
  dry: dryRun,
  verbose: true,
})

replace.replaceInFileSync({
  // replace all tokens in recordings
  files: 'src/__tests__/**/*.ts',
  // token are in json strings with escaped quotes
  from: /("([^"]*([Tt]oken|[Aa]ddress|Suffix|id))":[ ]?)"([^"*]*)"/g,
  to: (...args) => {
    const file = args[7]
    const key = args[2]
    const value = args[4]
    const censored = censoredValue(value, snakecase(key))

    console.log(file, { key, value, censored })

    return '$1"$2"'.replace('$1', args[1]).replace('$2', censored)
  },
  dry: dryRun,
  verbose: true,
})

function snakecase(value /*: string*/) {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase()
}
function censoredValue(value /*: string*/, name /*: string*/, replacer = '*') {
  if (value.length < name.length + 2) {
    // cant fit name, just return asterisks
    return value.replace(/./g, replacer)
  } else {
    // name in censored value length
    const length = value.length
    const asterisksCount = value.length - name.length
    const halfAsterisksCount = Math.floor(asterisksCount / 2)
    const leftAsterisksCount = halfAsterisksCount
    const rightAsterisksCount = asterisksCount - halfAsterisksCount

    // repeat left asterisks plus name plus repeat right asterisks
    return (
      replacer.repeat(leftAsterisksCount) +
      name +
      replacer.repeat(rightAsterisksCount)
    )
  }
}
function last(arr /*: any[]*/) {
  return arr[arr.length - 1]
}
