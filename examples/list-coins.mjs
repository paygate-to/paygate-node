// Prints every supported coin with its minimum, and the BTC price.
//
//   node examples/list-coins.mjs [EUR]

import { PayGate } from 'paygate-to';

const fiat = (process.argv[2] ?? 'USD').toUpperCase();
const paygate = new PayGate();

for (const coin of Object.values(await paygate.crypto.coins())) {
  console.log(`${coin.id.padEnd(24)} ${coin.label.padEnd(28)} min ${coin.minimum}`);
}
console.log(`\n1 BTC = ${await paygate.crypto.price('btc', fiat)} ${fiat}`);
