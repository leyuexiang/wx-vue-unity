// Minimal mouse/keyboard subset of Unity Render Streaming InputRemoting.
const fourCC = (text: string) => [...text].reduce((code, char) => (code << 8) | char.charCodeAt(0), 0)
export const KEY_CODES: Record<string, number> = {
  Space: 1, Enter: 2, Tab: 3, Backquote: 4, Quote: 5, Semicolon: 6, Comma: 7, Period: 8,
  Slash: 9, Backslash: 10, BracketLeft: 11, BracketRight: 12, Minus: 13, Equal: 14,
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`Key${String.fromCharCode(65 + i)}`, 15 + i])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i === 9 ? 0 : i + 1}`, 41 + i])),
  ShiftLeft: 51, ShiftRight: 52, AltLeft: 53, AltRight: 54, ControlLeft: 55, ControlRight: 56,
  MetaLeft: 57, MetaRight: 58, ContextMenu: 59, Escape: 60, ArrowLeft: 61, ArrowRight: 62,
  ArrowUp: 63, ArrowDown: 64, Backspace: 65, PageDown: 66, PageUp: 67, Home: 68, End: 69,
  Insert: 70, Delete: 71, CapsLock: 72, NumLock: 73, PrintScreen: 74, ScrollLock: 75, Pause: 76,
  NumpadEnter: 77, NumpadDivide: 78, NumpadMultiply: 79, NumpadAdd: 80, NumpadSubtract: 81,
  NumpadDecimal: 82, NumpadEqual: 83,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, 84 + i])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 94 + i])),
}
export function wrapInput(type: number, data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + data.length)
  const view = new DataView(buffer)
  view.setUint32(4, type, true)
  view.setUint32(8, data.length, true)
  new Uint8Array(buffer, 12).set(data)
  return buffer
}
function stateEvent(deviceId: number, format: string, state: Uint8Array, time: number): ArrayBuffer {
  const data = new Uint8Array(24 + state.length)
  const view = new DataView(data.buffer)
  view.setInt32(0, fourCC('STAT'), true)
  view.setUint16(4, data.length, true)
  view.setUint16(6, deviceId, true)
  view.setFloat64(8, time, true)
  view.setInt32(20, fourCC(format), true)
  data.set(state, 24)
  return wrapInput(4, data)
}
export function inputDescriptors(): ArrayBuffer[] {
  return ['Mouse', 'Keyboard'].map((name, i) => {
    const data = new TextEncoder().encode(JSON.stringify({ name, layout: name, deviceId: i + 1, usages: [], description: {
      m_InterfaceName: 'RawInput', m_DeviceClass: name, m_Manufacturer: '', m_Product: '',
      m_Serial: '', m_Version: '', m_Capabilities: '',
    } }))
    return wrapInput(3, data)
  })
}
export class LegacyInputEncoder {
  private keys = new Uint8Array(14)
  private lastPosition = { x: 0, y: 0 }
  private buttons = 0
  private startTime = Date.now()
  reset(): void { this.startTime = Date.now(); this.keys.fill(0); this.buttons = 0 }
  private time(): number { return (Date.now() - this.startTime) / 1000 }
  keyboard(event: Pick<KeyboardEvent, 'code' | 'type'>): ArrayBuffer | null {
    const index = KEY_CODES[event.code]
    if (index === undefined) return null
    const byte = index >> 3, bit = 1 << (index & 7)
    if (event.type === 'keydown') this.keys[byte] |= bit
    else this.keys[byte] &= ~bit
    return stateEvent(2, 'KEYS', this.keys, this.time())
  }
  release(): ArrayBuffer[] {
    this.keys.fill(0)
    this.buttons = 0
    return [stateEvent(2, 'KEYS', this.keys, this.time()), this.mouseState(this.lastPosition.x, this.lastPosition.y, 0, 0, 0, 0, this.buttons)]
  }
  pointer(event: MouseEvent | WheelEvent, rect: DOMRect, width: number, height: number): ArrayBuffer | null {
    if (!width || !height || !rect.width || !rect.height) return null
    const scale = Math.min(rect.width / width, rect.height / height)
    const left = rect.left + (rect.width - width * scale) / 2
    const top = rect.top + (rect.height - height * scale) / 2
    const x = (event.clientX - left) / scale
    const y = height - (event.clientY - top) / scale
    if (x < 0 || x > width || y < 0 || y > height) return null
    this.lastPosition = { x, y }
    this.buttons = event.buttons
    // Unity's native mouse uses positive, normalized steps for scrolling up.
    // Browser wheel deltas use the opposite sign and pixel/line/page units.
    const wheelScale = 'deltaMode' in event ? (event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? 1 : 1 / 100) : 0
    return this.mouseState(x, y, event.movementX / scale, -event.movementY / scale,
      'deltaX' in event ? -event.deltaX * wheelScale : 0, 'deltaY' in event ? -event.deltaY * wheelScale : 0, event.buttons)
  }
  private mouseState(x: number, y: number, dx: number, dy: number, sx: number, sy: number, buttons: number): ArrayBuffer {
    const state = new Uint8Array(30), view = new DataView(state.buffer)
    view.setFloat32(0, x, true); view.setFloat32(4, y, true)
    view.setFloat32(8, dx, true); view.setFloat32(12, dy, true)
    view.setFloat32(16, sx, true); view.setFloat32(20, sy, true)
    // Unity MouseButton order: left, right, middle, forward, back.
    view.setUint16(24, (buttons & 7) | ((buttons & 8) << 1) | ((buttons & 16) >> 1), true)
    return stateEvent(1, 'MOUS', state, this.time())
  }
}
