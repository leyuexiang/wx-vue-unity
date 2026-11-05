import { cloneDeep } from 'lodash-es'
import BaseConfig from '../../BaseWidgetConfig'
import type { TablePlusOption } from '../shared/tableTypes'

export const VTablePaginationInfo = {
  name: '分页表格',
  keyName: 'VTablePagination',
  packageName: 'Widget',
  icon: new URL('../assets/images/tables-basic.png', import.meta.url).href,
}

const createDefaultSource = () => [
  {
    key: 0,
    category: '智慧物联',
    drawingId: '01840e23-efb8-70d4-804b-9402de84d2d7',
    name: '冷源群控系统',
    action: '点击查看',
  },
  {
    key: 1,
    category: '智慧园区',
    drawingId: '01871289-7110-708d-80f2-c654ea652d7e',
    name: '中央空调模拟演示台系统',
    action: '点击查看',
  },
  {
    key: 2,
    category: '智慧物联',
    drawingId: '01864ef5-f3b8-7046-8062-680466d5157b',
    name: '换热站远程监控系统',
    action: '点击查看',
  },
  {
    key: 3,
    category: '无',
    drawingId: '018f94fe-12f4-7e6e-90c2-e7354270e7e1',
    name: 'RTO',
    action: '点击查看',
  },
  {
    key: 4,
    category: '电力能源',
    drawingId: '01831702-3460-7028-808d-77e4cee1a1bd',
    name: '变电站主接线图',
    action: '点击查看',
  },
  {
    key: 5,
    category: '智慧物联',
    drawingId: '01840e82-bd40-70d4-804b-9402de84d2f1',
    name: '制冷站',
    action: '点击查看',
  },
  {
    key: 6,
    category: '智慧水务',
    drawingId: '0186531b-a898-7046-8062-680466d51d97',
    name: '废水处理',
    action: '点击查看',
  },
  {
    key: 7,
    category: '电信机房',
    drawingId: '01840e6f-9ad0-70d4-804b-9402de84d2e8',
    name: '数据中心',
    action: '点击查看',
  },
  {
    key: 8,
    category: '智慧工厂',
    drawingId: '018fc8e1-6ccb-734c-a438-72a1c51dd2cb',
    name: '破碎筛分监控',
    action: '点击查看',
  },
  {
    key: 9,
    category: '电力能源',
    drawingId: '01840e78-7c40-70d4-804b-9402de84d2eb',
    name: '光伏系统',
    action: '点击查看',
  },
]

export default class Config extends BaseConfig {
  public attr = { l: 0, t: 0, w: 720, h: 340, zIndex: -1 }
  public info = cloneDeep(VTablePaginationInfo)
  public option: TablePlusOption = {
    variant: 'pagination',
    dataset: {
      dimensions: [
        { title: '场景', key: 'category' },
        { title: '图纸 ID', key: 'drawingId' },
        { title: '名称', key: 'name' },
        {
          title: '操作',
          key: 'action',
          link: {
            // 跳转目标由用户配置，新增组件不绑定示例公司的域名。
            baseUrl: '',
            params: [{ name: 'id', valueKey: 'drawingId' }],
            text: '点击查看',
            target: '_blank',
          },
        },
      ],
      source: createDefaultSource(),
    },
    align: 'center',
    rowHeight: 30,
    colWidth: 180,
    maxNum: 10,
    swiper: false,
    waitTime: 2,
    carousel: 'single',
    style: {
      colHeaders: true,
      bordered: true,
      hLine: true,
      vLine: true,
      stripe: true,
      stripeColor: '#407FFF1F',
      background: '#10131A',
      headerBackground: '#303746',
      textColor: '#E3E8F4',
      headerTextColor: '#FFFFFF',
      borderColor: '#407FFF66',
      fontSize: 14,
    },
    pagination: {
      page: 1,
      pageSize: 5,
      pageSizeOptions: [5, 10, 20, 30],
      maxPageBtn: 5,
      total: 10,
    },
    label: '分页表格',
  }
}
