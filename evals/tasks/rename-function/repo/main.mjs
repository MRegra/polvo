import { calc_total } from './lib/total.mjs';
import { report } from './lib/report.mjs';
const cart = [{ price: 2.5, qty: 2 }, { price: 1, qty: 3 }];
console.log(calc_total(cart));
console.log(report(cart));
