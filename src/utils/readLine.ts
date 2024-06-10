/// <reference types="node" />

import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const getLine = () => {
  return new Promise<string>(resolve => {
    rl.question('2fa code?', (input: string) => {
      resolve(input);
      rl.close();
    });
  });
};

export default getLine
