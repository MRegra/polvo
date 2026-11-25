import { calc_total } from './total.mjs';
export function report(items) {
  return `Total: ${calc_total(items).toFixed(2)}`;
}
