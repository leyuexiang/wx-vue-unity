import { describe, expect, it } from 'vitest'
import {
  createCommandBus, createSceneDefinition, createSceneStore, parseSceneDefinition,
  createDefaultEnviroWeatherConfig, createEnviroWeatherEffect, createDefaultWeatherV2Effect,
  isGregorianWeatherDate, isSupportedEnviroWeatherConfig, selectEnviroWeatherPreset,
  validateEnviroWeatherConfig, type EffectSpec,
} from '@/scene-platform'
import {
  getEditableEnviroWeatherConfig, getPersistableWeatherConfig, getRuntimeEnviroWeatherConfig,
  migrateLegacyWeatherConfig, restorePersistedWeatherEffects, updateEditorSceneWeather,
  setEditorWeatherEditGuard,
  ensureEnabledEditorSceneWeather,
} from '../editorSceneWeatherAdapter'
import { createSceneFourPackageDocuments, serializeSceneDefinitionToFourPackages } from '../sceneFourPackage'
import { assembleSceneDefinitionFromRuntimeFragments } from '../sceneRuntimeFragmentAssembler'
import { upgradeLegacyEditorDefaultVolumetricCloudEffect } from '../editorSceneWeatherDefaults'

const scene = (effects: EffectSpec[] = [], weather?: Record<string, unknown>) => createSceneDefinition({
  id: 'enviro-fixture', name: '天气测试', type: 'local3d',
  coordinateSystem: { kind: 'local', unit: 'meter', upAxis: 'Y', gridEnabled: true },
  objects: [], layers: [], effects, settings: weather ? { weather } : {}, metadata: {},
})

const roundTrip = (input: ReturnType<typeof scene>) => assembleSceneDefinitionFromRuntimeFragments({
  manifest: { fragmentType: 'manifest', contentJson: JSON.stringify(serializeSceneDefinitionToFourPackages(input)) },
  options: { sceneId: input.id },
})

describe('Enviro schema and provider isolation', () => {
  it('preserves null inheritance, explicit false and zero through validation and parsing', () => {
    const config = createDefaultEnviroWeatherConfig()
    config.overrides.clouds.enabled = false
    config.overrides.clouds.coveragePercent = 0
    config.overrides.fog.enabled = false
    config.overrides.fog.densityPercent = 0
    config.overrides.wind.strengthPercent = 0
    config.overrides.lighting.directMultiplier = 0
    expect(validateEnviroWeatherConfig(config)).toEqual([])
    const parsed = parseSceneDefinition(JSON.stringify(scene([createEnviroWeatherEffect(config)])))
    expect(parsed.effects[0]?.params).toEqual(config)
    expect(upgradeLegacyEditorDefaultVolumetricCloudEffect(parsed.effects[0]!)).toBe(parsed.effects[0])
  })

  it.each(['2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31'])('accepts Gregorian date %s', date => {
    expect(isGregorianWeatherDate(date)).toBe(true)
  })
  it.each(['2026-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-1-01'])('rejects invalid date %s', date => {
    expect(isGregorianWeatherDate(date)).toBe(false)
    const config = createDefaultEnviroWeatherConfig(); config.time.date = date
    expect(() => createEnviroWeatherEffect(config)).toThrow('time.date')
  })

  it('refuses invalid, missing and nonfinite fields instead of silently replacing them', () => {
    const config = createDefaultEnviroWeatherConfig()
    config.overrides.wind.directionDeg = 360
    config.overrides.fog.densityPercent = Number.NaN
    config.time.minutesOfDay = 1440
    config.location = { source: 'custom', latitude: null, longitude: 0 }
    expect(validateEnviroWeatherConfig(config)).toEqual(expect.arrayContaining([
      expect.stringContaining('directionDeg'), expect.stringContaining('densityPercent'),
      expect.stringContaining('minutesOfDay'), expect.stringContaining('location.coordinates'),
    ]))
    expect(validateEnviroWeatherConfig({ provider: 'enviro3', schemaVersion: 1 }).length).toBeGreaterThan(10)
  })

  it('reports malformed JSON quality values without invoking object string coercion', () => {
    const raw = { ...createDefaultEnviroWeatherConfig(), quality: { profile: { toString: 'low' } } }
    expect(validateEnviroWeatherConfig(raw)).toContain('weather.quality.profile is invalid.')
    expect(isSupportedEnviroWeatherConfig(raw)).toBe(false)
  })

  it('keeps future schemas opaque through legacy normalization, export and repeated load', () => {
    const raw = { provider: 'enviro3', schemaVersion: 99, futureField: { zero: 0, flag: false }, weatherScenario: 'preserved' }
    const input = parseSceneDefinition(JSON.stringify(scene([{ id: 'weather-main', type: 'weather', params: raw }])))
    expect(getPersistableWeatherConfig(roundTrip(roundTrip(input)))).toEqual(raw)
    expect(getRuntimeEnviroWeatherConfig(input)).toBeNull()
    expect(() => getEditableEnviroWeatherConfig(input)).toThrow('版本')
  })
})

describe('Enviro persistence and compatibility fixtures', () => {
  it.each(['fixed', 'system'] as const)('round trips %s time and every manual override without a settings copy', mode => {
    const config = createDefaultEnviroWeatherConfig()
    config.time = { mode, date: '2024-02-29', minutesOfDay: 1439, utcOffsetHours: -5 }
    config.overrides = {
      clouds: { enabled: true, coveragePercent: 100, baseHeightMeters: 20000 },
      fog: { enabled: true, densityPercent: 50, heightMeters: -1000 },
      wind: { strengthPercent: 100, directionDeg: 359 },
      lighting: { directMultiplier: 3, ambientMultiplier: 0 },
    }
    const input = scene([createEnviroWeatherEffect(config)], { staleValue: true })
    const restored = roundTrip(input)
    expect(restored.effects).toHaveLength(1)
    expect(restored.effects[0]?.params).toEqual(config)
    expect(restored.settings.weather).toBeUndefined()
    expect(getPersistableWeatherConfig(roundTrip(restored))).toEqual(config)
    expect(createSceneFourPackageDocuments(restored).threeD.baseConfig.weather).toEqual(config)
    expect(restorePersistedWeatherEffects(restored.effects, config)).toHaveLength(1)
  })

  it('leaves a weatherless legacy scene weatherless and does not dirty it while reading defaults', () => {
    const input = scene(); const before = JSON.stringify(input)
    expect(getEditableEnviroWeatherConfig(input).presetId).toBe('clear')
    expect(JSON.stringify(input)).toBe(before)
    expect(roundTrip(input).effects).toEqual([])
    expect(getRuntimeEnviroWeatherConfig(input)).toBeNull()
  })

  it('round trips an in-memory Weather V2 effect and a copied scene without losing legacy fields', () => {
    const effect = createDefaultWeatherV2Effect({ mode: 'snow', clouds: { coverage: 0.7 } })
    const input = scene([effect])
    const restored = roundTrip(input)
    expect(getPersistableWeatherConfig(restored)).toEqual(effect.params)
    const copied = { ...restored, id: 'copied-scene', name: '副本' }
    expect(roundTrip(copied).id).toBe('copied-scene')
    expect(getPersistableWeatherConfig(roundTrip(copied))).toEqual(effect.params)
  })

  it('prefers a persisted provider over an older V2 source and deduplicates repeated assembly', () => {
    const legacy = createDefaultWeatherV2Effect({ mode: 'rain' })
    const config = createDefaultEnviroWeatherConfig()
    const restored = restorePersistedWeatherEffects([legacy], config)
    expect(restored).toHaveLength(1)
    expect(restored[0]?.params).toEqual(config)
    expect(restorePersistedWeatherEffects(restored, config)).toEqual(restored)
  })

  it('keeps original legacy package data until the first explicit edit', () => {
    const raw = { mode: 'night', sun: { timeMode: 'realtime', dateTimeIso: '2026-01-01T20:00:00Z' }, shadow: { mapSize: 4096 } }
    const input = roundTrip(scene([], raw)); const before = JSON.stringify(input)
    const config = getEditableEnviroWeatherConfig(input)
    expect(config.time.mode).toBe('fixed')
    expect(config.time.date).toBe('2026-01-02')
    expect(config.time.minutesOfDay).toBe(0)
    expect(config.migration?.legacyBackup).toEqual(raw)
    expect(JSON.stringify(input)).toBe(before)
    expect(getPersistableWeatherConfig(roundTrip(input))).toEqual(raw)
  })

  it('migrates Weather V2 coherent date/time with zero minutes and false cloud override', () => {
    const v2 = createDefaultWeatherV2Effect({ mode: 'rain', sun: { dateTimeIso: '2026-01-01T20:00:00Z', timeOfDayMinutes: 0 }, clouds: { enabled: false, coverage: 0 } })
    const config = migrateLegacyWeatherConfig(v2.params)
    expect(config.presetId).toBe('rain')
    expect(config.time.date).toBe('2026-01-02')
    expect(config.time.minutesOfDay).toBe(0)
    expect(config.overrides.clouds.enabled).toBe(false)
    expect(config.overrides.clouds.coveragePercent).toBe(0)
    expect(config.migration?.legacyBackup).toEqual(v2.params)
    expect(getRuntimeEnviroWeatherConfig(scene([createEnviroWeatherEffect(config)]))).not.toHaveProperty('migration')
  })

  it('refuses oversized backups and future schema edits without data loss', () => {
    expect(() => migrateLegacyWeatherConfig({ extra: 'x'.repeat(32769) })).toThrow('备份')
    const store = createSceneStore(scene([{ id: 'weather-main', type: 'weather', params: { provider: 'enviro3', schemaVersion: 2 } }]))
    const bus = createCommandBus(store)
    expect(() => updateEditorSceneWeather({ store, execute: bus.execute, canEdit: () => true, config: createDefaultEnviroWeatherConfig() })).toThrow('降级')
    expect(bus.getUndoSize()).toBe(0)
  })

  it.each([Number.NaN, Infinity, [undefined], () => 1, new Date('2026-01-01')])('keeps strict persistence validation for opaque weather values (%s)', invalid => {
    const input = scene([{ id: 'weather-main', type: 'weather', params: { provider: 'future', schemaVersion: 2, invalid } }])
    expect(() => serializeSceneDefinitionToFourPackages(input)).toThrow('JSON')
  })
})

describe('Enviro commands and gesture history', () => {
  it('initializes Unity scenes with enabled clear weather and preserves saved presets and unknown data', () => {
    const empty = scene()
    const initialized = ensureEnabledEditorSceneWeather(empty)
    expect(empty.effects).toEqual([])
    expect(getEditableEnviroWeatherConfig(initialized)).toMatchObject({ enabled: true, presetId: 'clear' })
    expect(ensureEnabledEditorSceneWeather(initialized)).toBe(initialized)
    const saved = createDefaultEnviroWeatherConfig(); saved.presetId = 'rain'; saved.enabled = false
    saved.overrides.clouds.coveragePercent = 83
    expect(getEditableEnviroWeatherConfig(ensureEnabledEditorSceneWeather(scene([createEnviroWeatherEffect(saved)]))))
      .toMatchObject({ enabled: true, presetId: 'rain', overrides: { clouds: { coveragePercent: 83 } } })
    const future = scene([{ id: 'weather-main', type: 'weather', params: { provider: 'future', schemaVersion: 5 } }])
    expect(ensureEnabledEditorSceneWeather(future)).toBe(future)
  })
  it('checks the active editor lock and read-only flag at the write boundary', () => {
    const store = createSceneStore(scene()); const bus = createCommandBus(store)
    const release = setEditorWeatherEditGuard(() => false)
    try {
      expect(() => updateEditorSceneWeather({ store, execute: bus.execute, canEdit: () => true, config: createDefaultEnviroWeatherConfig() })).toThrow('权限')
      expect(bus.getUndoSize()).toBe(0)
    } finally { release() }
    const readOnlyScene = scene(); readOnlyScene.settings.readOnly = true; store.loadScene(readOnlyScene)
    expect(() => updateEditorSceneWeather({ store, execute: bus.execute, canEdit: () => true, config: createDefaultEnviroWeatherConfig() })).toThrow('权限')
  })
  it('undoes first creation to no weather, merges one gesture, and separates later gestures', () => {
    const store = createSceneStore(scene()); const bus = createCommandBus(store)
    const config = createDefaultEnviroWeatherConfig()
    const write = (gestureId: string, coverage: number) => {
      config.overrides.clouds.coveragePercent = coverage
      updateEditorSceneWeather({ store, execute: bus.execute, canEdit: () => true, config, gestureId })
    }
    write('gesture-1', 20); write('gesture-1', 40)
    expect(bus.getUndoSize()).toBe(1)
    write('gesture-2', 80)
    expect(bus.getUndoSize()).toBe(2)
    bus.undo()
    expect(getEditableEnviroWeatherConfig(store.getScene()).overrides.clouds.coveragePercent).toBe(40)
    bus.undo()
    expect(store.getEffects()).toEqual([])
    expect(getPersistableWeatherConfig(roundTrip(store.getScene()))).toEqual({})
    bus.redo(); bus.redo()
    expect(getEditableEnviroWeatherConfig(roundTrip(store.getScene())).overrides.clouds.coveragePercent).toBe(80)
  })

  it('resets all manual overrides as one preset operation and preserves date/time and quality', () => {
    const config = createDefaultEnviroWeatherConfig(); config.overrides.wind.strengthPercent = 90
    const next = selectEnviroWeatherPreset(config, 'snow')
    expect(next.overrides.wind.strengthPercent).toBeNull()
    expect(next.time).toEqual(config.time)
    expect(next.quality).toEqual(config.quality)
    expect(config.overrides.wind.strengthPercent).toBe(90)
  })

  it('checks permissions before changing the store or history', () => {
    const store = createSceneStore(scene()); const bus = createCommandBus(store)
    expect(() => updateEditorSceneWeather({ store, execute: bus.execute, canEdit: () => false, config: createDefaultEnviroWeatherConfig() })).toThrow('权限')
    expect(store.getEffects()).toEqual([])
    expect(bus.getUndoSize()).toBe(0)
    expect(isSupportedEnviroWeatherConfig(getEditableEnviroWeatherConfig(store.getScene()))).toBe(true)
  })
})
