import { describe, expect, it } from 'vitest'
import { inputDescriptors, KEY_CODES, LegacyInputEncoder } from '@/unity-runtime/connection/LegacyInputEncoder'
import { parseUnityRuntimeEvent } from '@/unity-runtime/connection/LegacyUnityTransport'

const view = (buffer: ArrayBuffer) => new DataView(buffer)

describe('LegacyInputEncoder', () => {
  it('encodes Unity InputRemoting device descriptors', () => {
    const [mouse, keyboard] = inputDescriptors()
    expect(view(mouse).getUint32(4, true)).toBe(3)
    expect(view(keyboard).getUint32(4, true)).toBe(3)
    expect(view(mouse).getUint32(8, true)).toBeGreaterThan(20)
    const payload = new Uint8Array(mouse, 12, view(mouse).getUint32(8, true))
    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({ layout: 'Mouse', usages: [] })
  })

  it('preserves keyboard state between key down and key up', () => {
    const encoder = new LegacyInputEncoder()
    const down = encoder.keyboard({ code: 'KeyA', type: 'keydown' })!
    const up = encoder.keyboard({ code: 'KeyA', type: 'keyup' })!
    const keyByteOffset = 12 + 24 + (KEY_CODES.KeyA >> 3)
    const bit = 1 << (KEY_CODES.KeyA & 7)
    expect(new Uint8Array(down)[keyByteOffset] & bit).toBe(bit)
    expect(new Uint8Array(up)[keyByteOffset] & bit).toBe(0)
  })

  it('maps displayed video coordinates into Unity video space', () => {
    const encoder = new LegacyInputEncoder()
    const event = { clientX: 320, clientY: 180, movementX: 0, movementY: 0, buttons: 1, type: 'mousemove' } as MouseEvent
    const packet = encoder.pointer(event, { left: 0, top: 0, width: 640, height: 360 } as DOMRect, 1920, 1080)!
    const stateOffset = 12 + 24
    expect(view(packet).getFloat32(stateOffset, true)).toBeCloseTo(960)
    expect(view(packet).getFloat32(stateOffset + 4, true)).toBeCloseTo(540)
  })

  it.each([
    [0, -100, 1], [0, 100, -1],
    [1, -3, 1], [1, 3, -1],
    [2, -1, 1], [2, 1, -1],
    [0, -10, 0.1],
  ])('normalizes browser wheel units (mode %s, delta %s) into Unity steps', (deltaMode, deltaY, expected) => {
    const encoder = new LegacyInputEncoder()
    const event = { type: 'wheel', clientX: 320, clientY: 180, movementX: 0, movementY: 0,
      buttons: 0, deltaX: 0, deltaY, deltaMode } as WheelEvent
    const packet = encoder.pointer(event, { left: 0, top: 0, width: 640, height: 360 } as DOMRect, 1920, 1080)!
    expect(view(packet).getFloat32(12 + 24 + 20, true)).toBeCloseTo(expected)
  })

  it('保留 Unity 主动事件的会话和场景代次', () => {
    const event = parseUnityRuntimeEvent('editor.v1.selection.changed', {
      params: {
        envelope: {
          protocolVersion: 1,
          sessionId: 'session-1',
          sceneId: 'scene-1',
          sceneGeneration: 3,
          eventId: 'event-1',
          payload: { instanceId: 'object-1' },
        },
      },
    })

    expect(event).toMatchObject({
      protocolVersion: 1,
      sessionId: 'session-1',
      sceneId: 'scene-1',
      sceneGeneration: 3,
      eventId: 'event-1',
      payload: { instanceId: 'object-1' },
    })
  })
})
