export function capturePayment(payment) {
  return { ...payment, status: 'captured' };
}
