// Shared types for the Weekly Brief backend.
// Mirrors the shapes app.py/modules.py worked with in the original Flask app.

export type Bindings = {
  DB: D1Database
  R2: R2Bucket
  GEMINI_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
}

export type AppEnv = { Bindings: Bindings }

export interface Entity {
  id: string
  name: string
  group?: string
}

export interface IndicatorPoint {
  date: string
  value: number
}

export interface Indicator {
  id: string
  label: string
  unit?: string
  direction_bad?: string
  series: IndicatorPoint[]
  note?: string
}

export interface Trend {
  title: string
  detail: string
  indicator?: string
  entities?: string[]
}

export interface Corpus {
  source_note: string
  entities: Entity[]
  indicators: Indicator[]
  trends: Trend[]
  sections: string[]
}

export interface NewsItem {
  section: string
  headline: string
  source: string
  grade: string
  summary: string
  impact?: string
  regulatory?: string
  flag?: string
  entities?: string[]
}

export interface PulseRow {
  indicator: string
  weekly: string
  previous: string
  direction: string
  implication?: string
}

export interface PdfMeta {
  name: string
  url: string
  size: number
  r2_key?: string
}

export interface Edition {
  id: string
  label: string
  date: string
  status: string
  exec_summary: string
  speed_read: string[]
  structural: string
  pulse: PulseRow[]
  items: NewsItem[]
  watchlist: string[]
  beyond: string
  pdf?: PdfMeta | null
}

export interface EditionListRow {
  id: string
  week: number
  label: string
  date: string
  sections: number
  items: number
  pdf?: PdfMeta | null
}

export interface ViewSectionItem {
  title: string
  plain: string
  grade: string
  body: string
  source: string
  impact: string
  impact_label: string
}

export interface ViewSection {
  title: string
  items: ViewSectionItem[]
}

export interface PulseViewItem {
  name: string
  current: string | number
  prior: string | number
  change: number | string
  avg: number | string
  history: number[]
  source: string
  implication: string
}

export interface PulseGroup {
  category: string
  items: PulseViewItem[]
}

export interface TrendView {
  title: string
  value: number | string
  unit: string
  change: number
  points: number[]
  avg: number | string
  prior: number | string
  context: string
}

export interface DeltaItem {
  status: 'new' | 'resolved' | 'escalated'
  title: string
}

export interface CarryItem {
  title: string
  since_week: number
}

export interface ViewModel {
  id: string
  week: number
  label: string
  date: string
  status: string
  exec_summary: string
  speed_read: string[]
  structural: string
  beyond: string
  sections: ViewSection[]
  indicators: PulseGroup[]
  trends: TrendView[]
  delta: DeltaItem[]
  carry_forward: CarryItem[]
  pdf?: PdfMeta
}

export interface Note {
  id: string
  edition: string
  anchor: string
  x: number
  y: number
  text: string
  author: string
  colour: string
  resolved: boolean
  created: string
  updated: string
  replies: { author: string; text: string; ts: string }[]
}
