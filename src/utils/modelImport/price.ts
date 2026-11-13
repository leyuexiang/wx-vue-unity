/**
 * 将模型表单中的十进制元金额转换为数据库整数分。
 * 使用十进制字符和大整数运算，避免二进制浮点乘法造成一分钱误差或静默舍入。
 */
export function modelPriceInCents(value: unknown): number {
  const message = '价格须为0.01至21474836.47元，最多两位小数'
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(message)
  const decimal = String(value).trim()
  if (decimal.length > 32 || !/^\d+(?:\.\d{1,2})?$/.test(decimal)) throw new Error(message)
  const [whole, fraction = ''] = decimal.split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents < 1n || cents > 2147483647n) throw new Error(message)
  return Number(cents)
}
