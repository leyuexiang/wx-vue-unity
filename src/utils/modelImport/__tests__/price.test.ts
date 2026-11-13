import { describe, expect, it } from 'vitest'
import { modelPriceInCents } from '../price'

describe('模型价格按十进制元转换为整数分', () => {
  it('精确处理最小金额、浮点边界和数据库上限', () => {
    expect(modelPriceInCents('0.01')).toBe(1)
    expect(modelPriceInCents(0.29)).toBe(29)
    expect(modelPriceInCents('12.99')).toBe(1299)
    expect(modelPriceInCents('21474836.47')).toBe(2147483647)
  })

  it('拒绝不足一分、超出两位小数、无效值和整数溢出', () => {
    for (const value of ['', undefined, '0', '-1', '0.009', '1.001', '21474836.48', '1e3', Number.NaN]) {
      expect(() => modelPriceInCents(value)).toThrow('价格')
    }
  })
})
