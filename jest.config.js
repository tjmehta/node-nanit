const config = {
  // run tests in series
  runInBand: true,
  // testEnvironmentOptions: {
  //   customExportConditions: ['node', 'node-addons'],
  // },
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.(js|ts)$': 'babel-jest',
  },
}

export default config
