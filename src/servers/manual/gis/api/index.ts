// @ts-nocheck
import request from '@/request.ts'

/**
 * 查询 GIS 信息列表返回数据
 */
export interface ListGisTileRes {
  code: number
  data: {
    /** GIS 信息编号：新目录使用字符串，兼容旧接口及既有测试数据的数值编号。 */
    id: string | number
    /** 切片名称 */
    gisName: string
    /** 数据类型 */
    dataType: string
    /** 坐标系 */
    coordinate: string
    /** 级别 */
    level: number
    /** 瓦片大小 */
    tileSize: string
    /** 存储路径 */
    path: string
    /** gis 文件名 */
    fileName: string
    /** 是否需要切片 */
    sliceFlag: boolean
    /** 切片规则 */
    sliceRule: string
    /** 纬度 */
    latitude: string
    /** 经度 */
    longitude: string
    /** 可选的真实覆盖范围，顺序为西、南、东、北，旧接口可不返回。 */
    bounds?: number[]
    /** 可选的真实切片后缀，旧接口仍沿用 JPG。 */
    fileExtension?: string
  }[]
  msg: string
}

/** GIS 切片查询类型：高程和影像使用不同的数据类型标识。 */
export type GisTileDataType = 'ELEVATION' | 'SATELLITE'

/**
 * 查询 GIS 信息列表，配置了切片路径的
 * @param dataType - 数据类型：ELEVATION 表示高程，SATELLITE 表示影像
 * @returns
 */
export function listGisTile(dataType: GisTileDataType, signal?: AbortSignal): Promise<ListGisTileRes> {
  /**
   * 以 `/api` 作为接口根路径；统一请求拦截器会按当前平台补齐路径段，
   * 运营端最终请求 `/api/operation/webgis/info/list`，并保留传入的数据类型。
   */
  return request.get(`/api/webgis/info/list?dataType=${encodeURIComponent(dataType)}`, { signal })
}
