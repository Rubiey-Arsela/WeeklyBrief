// Shared types for the Weekly Brief backend.
// Mirrors the shapes app.py/modules.py worked with in the original Flask app.

export type Bindings = {
  DB: D1Database
  R2: R2Bucket
  GEMINI_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  // Microsoft Entra ID (Azure AD) sign-in — login is only enforced once
  // MS_CLIENT_ID + MS_CLIENT_SECRET are both set. See src/auth.ts.
  MS_CLIENT_ID?: string
  MS_CLIENT_SECRET?: string
  MS_TENANT_ID?: string
  MS_REDIRECT_URI?: string
  MS_ALLOWED_DOMAIN?: string
  SESSION_SECRET?: string
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
  // Exact URL of the original source article, when known (backfilled from a
  // Reference List supplied alongside the weekly PDF, or extracted directly
  // in future editions). Falls back to a Google-search link in the frontend
  // (see sourceArticleLink() in frontend.html) when this is absent.
  source_url?: string
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
  source_url?: string
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
  // Arrow/colour derived purely from comparing `current` and `prior` at
  // render time — computed once in buildIndicators() and trusted as-is by
  // the frontend, so the badge can never disagree with the two values
  // printed beside it.
  dir: 'up' | 'down' | 'flat'
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
  // Edition id (e.g. "W45") for each entry in `points`, same order/length,
  // so the chart can print an x-axis label under every plotted point
  // instead of a bare unlabelled line.
  weeks: string[]
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

export interface Highlight {
  id: string
  edition: string
  item_key: string
  start_offset: number
  end_offset: number
  colour: string
  text_snippet: string
  author: string
  created: string
  updated: string
}
