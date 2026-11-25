import { calculateTotal } from './total.mjs';
export function report(items) {
  return `Total: ${calculateTotal(items).toFixed(2)}`;
}
